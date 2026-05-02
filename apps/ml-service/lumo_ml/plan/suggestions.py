"""Per-turn suggestion-chip generation — Python port of
``apps/web/lib/chat-suggestions.ts:buildAssistantSuggestions``.

Phase 1 lane SUGGESTIONS-MIGRATE-PYTHON-1. Runs behind codex's
parallel-write telemetry: codex's plan-client logs both the existing
TS chip output and this Python output into ``agent_plan_compare`` for
shadow comparison; TS stays authoritative until cutover.

Behaviour parity is the goal — every regex, every chip string, every
helper-cascade fall-through must match the TS source. Structural
improvements (history embedding, diversity, LLM-generated chips)
land in their own follow-up lanes (SUGGESTIONS-PERSONALIZED-PYTHON-1
/ SUGGESTIONS-DIVERSITY-1 / SUGGESTIONS-LLM-REASONING-1).

Routing axis is ``planning_step``, NOT ``intent_bucket`` (recon §2).
Eight helpers — six in the ``clarification`` cascade plus one each
for ``selection`` / ``confirmation`` / ``post_booking``. The
``asksForFreeTextIdentity`` early-return on clarification is critical:
when the assistant asks for a passport / full name / DOB, no chips
are emitted and the user fills the field free-form.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Literal

from ..core import traced
from .schemas import Suggestion

PlanningStep = Literal["clarification", "selection", "confirmation", "post_booking"]


# ──────────────────────────────────────────────────────────────────────
# Regex constants — module-level so they're compiled once. Verbatim
# ports of the JS regex literals in chat-suggestions.ts. We add
# ``re.IGNORECASE`` because the TS uses the ``/i`` flag.
# ──────────────────────────────────────────────────────────────────────

_CLARIFICATION_QUESTION_RE = re.compile(
    r"\b(pick|choose|tell me|what|which|when|how many|would you|should i|do you want|works)\b",
    re.IGNORECASE,
)
_SELECTION_NEEDS_RE = re.compile(
    r"\b(pick|choose|select|option|offer|offers|which|nonstop|cheapest|fastest)\b",
    re.IGNORECASE,
)
_CONFIRMATION_NEEDS_RE = re.compile(
    r"\b(confirm|book|booking|final price|ready|tap|traveler|payment|change|cancel)\b",
    re.IGNORECASE,
)
_POST_BOOKING_NEEDS_RE = re.compile(
    r"\b(booked|confirmed|confirmation|next|hotel|ground|transport|calendar|receipt)\b",
    re.IGNORECASE,
)
_FREE_TEXT_IDENTITY_RE = re.compile(
    r"\b(full name|legal name|traveler names?|passenger names?|passport|date of birth|dob)\b",
    re.IGNORECASE,
)
_DATE_RE = re.compile(
    r"\b(date|dates|when|return date|weekend|travel window)\b",
    re.IGNORECASE,
)
_AIRPORT_RE = re.compile(
    r"\b(airport|origin|departure|depart|from where|which city|city should i use)\b",
    re.IGNORECASE,
)
_TRIP_SHAPE_RE = re.compile(
    r"\b(round ?trip|one-way|trip type|return flight)\b",
    re.IGNORECASE,
)
_TRAVELER_RE = re.compile(
    r"\b(how many|passengers?|travelers?|people|party size)\b",
    re.IGNORECASE,
)
_BUDGET_RE = re.compile(
    r"\b(budget|price|spend|cap|limit|cheap|comfortable)\b",
    re.IGNORECASE,
)
_COMFORT_RE = re.compile(
    r"\b(cheapest|fastest|comfortable|optimi[sz]e|priority|prefer)\b",
    re.IGNORECASE,
)

_REGION_CHICAGO_RE = re.compile(r"\b(chicago|chi)\b", re.IGNORECASE)
_REGION_NYC_RE = re.compile(r"\b(new york|nyc|manhattan|brooklyn)\b", re.IGNORECASE)
_REGION_SF_RE = re.compile(r"\b(sf|sfo|san francisco|bay area)\b", re.IGNORECASE)


# Hardcoded English month names match the TS code's
# ``Intl.DateTimeFormat("en-US", { month: "long" })`` output without
# inheriting the host's locale.
_MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

_MAX_SUGGESTIONS = 4
_MIN_SUGGESTIONS = 2


# ──────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────


@traced("plan.suggestions.build")
def build_assistant_suggestions(
    *,
    assistant_text: str,
    planning_step: PlanningStep = "clarification",
    latest_user_message: str | None = None,
    now: datetime | None = None,
    user_region: str | None = None,
) -> list[Suggestion]:
    """Generate up to four suggestion chips for an assistant turn.

    Returns ``[]`` when:
      * the assistant text doesn't need a user decision (per-step gate),
      * the helper cascade returns no candidates,
      * after dedupe fewer than two unique suggestions remain.

    The TS reference returns ``null`` in those cases (no SSE frame
    emitted); we use ``[]`` here because ``PlanResponse.suggestions`` is
    a non-optional list. Codex's plan-client treats both equivalently
    per the recon doc §11.5.
    """
    text = _normalize_text(assistant_text)
    if not _needs_user_decision(text, planning_step):
        return []

    when = now if now is not None else datetime.now(tz=timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    latest_user = _normalize_text(latest_user_message or "")

    seeds = _suggestions_for_planning_step(
        planning_step=planning_step,
        text=text,
        latest_user=latest_user,
        now=when,
        user_region=user_region,
    )
    if not seeds:
        return []

    deduped = _dedupe_suggestions(seeds)[:_MAX_SUGGESTIONS]
    if len(deduped) < _MIN_SUGGESTIONS:
        return []

    return [
        Suggestion(
            id=f"s{index + 1}",
            label=label,
            value=value,
        )
        for index, (label, value) in enumerate(deduped)
    ]


# ──────────────────────────────────────────────────────────────────────
# Routing
# ──────────────────────────────────────────────────────────────────────


def _suggestions_for_planning_step(
    *,
    planning_step: PlanningStep,
    text: str,
    latest_user: str,
    now: datetime,
    user_region: str | None,
) -> list[tuple[str, str]]:
    if planning_step == "clarification":
        if _asks_for_free_text_identity(text):
            return []
        cascade = (
            _date_suggestions(text, now),
            _airport_suggestions(text, latest_user, user_region),
            _trip_shape_suggestions(text),
            _traveler_suggestions(text),
            _budget_suggestions(text),
            _comfort_suggestions(text),
        )
        for seeds in cascade:
            if seeds:
                return seeds
        return []
    if planning_step == "selection":
        return _selection_suggestions(text)
    if planning_step == "confirmation":
        return _confirmation_suggestions(text)
    return _post_booking_suggestions(text)


def _needs_user_decision(text: str, planning_step: PlanningStep) -> bool:
    if planning_step == "clarification":
        return _looks_like_clarification_question(text)
    if planning_step == "selection":
        return bool(_SELECTION_NEEDS_RE.search(text))
    if planning_step == "confirmation":
        return bool(_CONFIRMATION_NEEDS_RE.search(text))
    return bool(_POST_BOOKING_NEEDS_RE.search(text))


def _looks_like_clarification_question(text: str) -> bool:
    if "?" not in text:
        return False
    return bool(_CLARIFICATION_QUESTION_RE.search(text))


def _asks_for_free_text_identity(text: str) -> bool:
    return bool(_FREE_TEXT_IDENTITY_RE.search(text))


# ──────────────────────────────────────────────────────────────────────
# Clarification helpers (cascade order matters — first non-empty wins)
# ──────────────────────────────────────────────────────────────────────


def _date_suggestions(text: str, now: datetime) -> list[tuple[str, str]]:
    if not _DATE_RE.search(text):
        return []
    first_start, first_end = _next_weekend(now, ordinal=1)
    second_start, second_end = _next_weekend(now, ordinal=2)
    seeds: list[tuple[str, str]] = [
        (
            f"Next weekend ({_format_range(first_start, first_end, compact=True)})",
            f"{_format_date_value(first_start)} to {_format_date_value(first_end)}",
        ),
        (
            f"In 2 weeks ({_format_range(second_start, second_end, compact=True)})",
            f"{_format_date_value(second_start)} to {_format_date_value(second_end)}",
        ),
    ]
    memorial_start, memorial_end = _memorial_day_weekend(now.year)
    if memorial_start > now:
        seeds.append((
            "Memorial Day weekend",
            f"{_format_date_value(memorial_start)} to {_format_date_value(memorial_end)}",
        ))
    else:
        mid_june = datetime(now.year, 6, 12, tzinfo=timezone.utc)
        mid_june_end = _add_days(mid_june, 2)
        seeds.append((
            f"Mid-June ({_format_range(mid_june, mid_june_end, compact=True)})",
            f"{_format_date_value(mid_june)} to {_format_date_value(mid_june_end)}",
        ))
    return seeds


def _airport_suggestions(
    text: str,
    latest_user: str,
    user_region: str | None,
) -> list[tuple[str, str]]:
    if not _AIRPORT_RE.search(text):
        return []
    haystack = " ".join((text, latest_user, user_region or "")).lower()
    if _REGION_CHICAGO_RE.search(haystack):
        return [
            ("Chicago O'Hare (ORD)", "Depart from Chicago O'Hare (ORD)"),
            ("Chicago Midway (MDW)", "Depart from Chicago Midway (MDW)"),
            (
                "Use either Chicago airport",
                "Depart from either ORD or MDW, whichever has the better option",
            ),
        ]
    if _REGION_NYC_RE.search(haystack):
        return [
            ("JFK", "Depart from New York JFK"),
            ("LaGuardia (LGA)", "Depart from LaGuardia (LGA)"),
            ("Newark (EWR)", "Depart from Newark (EWR)"),
        ]
    if _REGION_SF_RE.search(haystack):
        return [
            ("San Francisco (SFO)", "Depart from San Francisco (SFO)"),
            ("Oakland (OAK)", "Depart from Oakland (OAK)"),
            ("San Jose (SJC)", "Depart from San Jose (SJC)"),
        ]
    return []


def _trip_shape_suggestions(text: str) -> list[tuple[str, str]]:
    if not _TRIP_SHAPE_RE.search(text):
        return []
    return [
        ("Roundtrip, 1 passenger", "Roundtrip and one passenger"),
        ("One-way, 1 passenger", "One-way and one passenger"),
        ("Roundtrip, 2 passengers", "Roundtrip and two passengers"),
    ]


def _traveler_suggestions(text: str) -> list[tuple[str, str]]:
    if not _TRAVELER_RE.search(text):
        return []
    return [
        ("Just me", "One traveler"),
        ("Two travelers", "Two travelers"),
        ("Family of four", "Four travelers"),
    ]


def _budget_suggestions(text: str) -> list[tuple[str, str]]:
    if not _BUDGET_RE.search(text):
        return []
    return [
        ("Keep it lean", "Optimize for the lowest reasonable price"),
        ("Mid-range", "Use a mid-range budget with a good comfort tradeoff"),
        ("No hard limit", "No hard budget limit; prioritize the best fit"),
    ]


def _comfort_suggestions(text: str) -> list[tuple[str, str]]:
    if not _COMFORT_RE.search(text):
        return []
    return [
        ("Cheapest", "Optimize for the cheapest options"),
        ("Fastest", "Optimize for the fastest options"),
        ("Most comfortable", "Optimize for comfort"),
    ]


# ──────────────────────────────────────────────────────────────────────
# Single-helper steps
# ──────────────────────────────────────────────────────────────────────


def _selection_suggestions(text: str) -> list[tuple[str, str]]:
    if not _SELECTION_NEEDS_RE.search(text):
        return []
    return [
        ("Cheapest", "Pick the cheapest option"),
        ("Fastest", "Pick the fastest option"),
        ("Nonstop only", "Show me nonstop options only"),
    ]


def _confirmation_suggestions(text: str) -> list[tuple[str, str]]:
    if not _CONFIRMATION_NEEDS_RE.search(text):
        return []
    return [
        ("Confirm booking", "Confirm booking"),
        ("Different traveler", "Use a different traveler"),
        ("Change dates", "Change dates"),
        ("Cancel", "Cancel"),
    ]


def _post_booking_suggestions(text: str) -> list[tuple[str, str]]:
    if not _POST_BOOKING_NEEDS_RE.search(text):
        return []
    return [
        ("Book hotel", "Book a hotel for this trip"),
        ("Add ground transport", "Add ground transport"),
        ("Send to calendar", "Send this booking to my calendar"),
    ]


# ──────────────────────────────────────────────────────────────────────
# Dedupe + date math + formatters — verbatim ports
# ──────────────────────────────────────────────────────────────────────


def _dedupe_suggestions(seeds: list[tuple[str, str]]) -> list[tuple[str, str]]:
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for label_raw, value_raw in seeds:
        label = label_raw.strip()
        value = value_raw.strip()
        if not label or not value:
            continue
        key = f"{label.lower()}::{value.lower()}"
        if key in seen:
            continue
        seen.add(key)
        out.append((label, value))
    return out


def _next_weekend(now: datetime, *, ordinal: int) -> tuple[datetime, datetime]:
    """Mirror ``nextWeekend(now, ordinal)`` from chat-suggestions.ts.

    The TS code uses ``getUTCDay()`` where Sunday=0, Saturday=6;
    ``daysUntilSaturday = (6 - day + 7) % 7 || 7`` — the ``|| 7``
    means "if today is Saturday, jump to next Saturday, not today".
    """
    base = _utc_date_only(now)
    day_of_week = (base.weekday() + 1) % 7  # python: Mon=0 → JS: Sun=0..Sat=6
    days_until_saturday = (6 - day_of_week + 7) % 7 or 7
    start = _add_days(base, days_until_saturday + (ordinal - 1) * 7)
    end = _add_days(start, 2)
    return start, end


def _memorial_day_weekend(year: int) -> tuple[datetime, datetime]:
    """Memorial Day = last Monday of May. Weekend = Sat–Tue around it.

    TS: ``mondayOffset = (lastMayDay.getUTCDay() + 6) % 7``;
    Python's ``weekday()`` already returns Mon=0..Sun=6, so
    ``mondayOffset = lastMayDay.weekday()`` directly.
    """
    last_may_day = datetime(year, 5, 31, tzinfo=timezone.utc)
    monday_offset = last_may_day.weekday()
    memorial_day = _add_days(last_may_day, -monday_offset)
    start = _add_days(memorial_day, -2)
    end = _add_days(memorial_day, 2)
    return start, end


def _add_days(date: datetime, days: int) -> datetime:
    return date + timedelta(days=days)


def _utc_date_only(date: datetime) -> datetime:
    """Strip the time component and pin tz to UTC, matching the TS
    ``new Date(Date.UTC(y, m, d))`` round-trip."""
    return datetime(date.year, date.month, date.day, tzinfo=timezone.utc)


def _format_range(start: datetime, end: datetime, *, compact: bool = False) -> str:
    same_month = start.month == end.month
    month = _month_name(start)
    start_day = start.day
    end_text = str(end.day) if same_month else f"{_month_name(end)} {end.day}"
    if compact:
        return f"{month} {start_day}-{end_text}"
    return f"{month} {start_day} to {end_text}"


def _format_date_value(date: datetime) -> str:
    return f"{_month_name(date)} {date.day}, {date.year}"


def _month_name(date: datetime) -> str:
    return _MONTH_NAMES[date.month - 1]


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()
