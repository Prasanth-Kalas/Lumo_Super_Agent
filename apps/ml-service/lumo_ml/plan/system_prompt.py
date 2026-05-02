"""Verbatim Python port of ``apps/web/lib/system-prompt.ts``.

Single canonical function ``build_system_prompt(...)`` mirroring TS's
``buildSystemPrompt(opts)``. Output is one concatenated string in
the same 13-section order the TS function emits, so a Levenshtein
diff against TS output stays > 0.95 in the eval (recon §10a → axes
pivoted to ``mode × memory × ambient × booking × agent_health``).

Helper functions mirror their TS counterparts byte-for-byte so the
indentation and newline structure of each block match. The
``VOICE_MODE_PROMPT`` constant lives in :mod:`lumo_ml.plan.voice_format`
to keep the 350-line block out of the function body.

Note on the Date.toISOString() compat: Python's
``datetime.isoformat()`` emits ``2026-05-02T00:00:00+00:00`` while JS
emits ``2026-05-02T00:00:00.000Z``. The format helper here matches
JS exactly so the ``TODAY:`` line doesn't drift the Levenshtein
score on every comparison.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .schemas import (
    AddressPayload,
    AgentManifestForPrompt,
    AmbientContext,
    BookingProfileSnapshot,
    InteractionMode,
    MemorySnapshot,
    UserProfile,
)
from .voice_format import VOICE_MODE_PROMPT

# Mirrors apps/web/lib/booking-profile-core.ts:90-99 FIELD_ORDER —
# the order matters for Levenshtein parity.
_BOOKING_FIELD_ORDER: tuple[str, ...] = (
    "name",
    "email",
    "phone",
    "payment_method_id",
    "traveler_profile",
    "passport",
    "passport_optional",
    "dob",
)


def build_system_prompt(
    *,
    agents: list[AgentManifestForPrompt],
    now: datetime,
    user_region: str,
    user_first_name: str | None = None,
    mode: InteractionMode = "text",
    memory: MemorySnapshot | None = None,
    ambient: AmbientContext | None = None,
    booking_profile: BookingProfileSnapshot | None = None,
) -> str:
    """Mirror of ``buildSystemPrompt(opts)`` from the TS reference.

    Returns a single concatenated string. Ordering, indentation, and
    trailing-newline behaviour match the TS template literal exactly
    — any whitespace drift will dock the Levenshtein eval.
    """
    agent_lines = "\n".join(_agent_line(a) for a in agents)
    unavailable_lines = "\n".join(
        _unavailable_line(a) for a in agents if a.health_score < 0.6
    )

    memory_block = _format_memory_block(memory)
    ambient_block = _format_ambient_block(ambient)
    booking_profile_block = _booking_profile_snapshot_to_prompt(booking_profile)

    user_line = f"USER: {user_first_name}" if user_first_name else ""

    capabilities = agent_lines if agent_lines else "  (none currently registered)"
    unavailable_section = (
        f"CURRENTLY UNAVAILABLE:\n{unavailable_lines}\n" if unavailable_lines else ""
    )
    voice_section = f"\nVOICE MODE:\n{VOICE_MODE_PROMPT}\n" if mode == "voice" else ""

    return (
        f"You are Lumo, a universal personal concierge.\n"
        f"\n"
        f"Your job is to get the user the thing they want — food, flights, hotels, rides, whatever — with the fewest possible turns. You are chat-first and voice-first. Users may speak or type. Be warm, brief, and precise.\n"
        f"\n"
        f"TODAY: {_iso_string_js_compat(now)}\n"
        f"USER REGION: {user_region}\n"
        f"{user_line}\n"
        f"{ambient_block}\n"
        f"{memory_block}\n"
        f"{booking_profile_block}\n"
        f"CAPABILITIES YOU HAVE (via tools):\n"
        f"{capabilities}\n"
        f"\n"
        f"{unavailable_section}\n"
        f"\n"
        f"RULES:\n"
        f"1. Pick the correct tool for the user's intent. If the intent is ambiguous, ask ONE short clarifying question — do not ask multiple. Phrase it as a helpful planning prompt, not an interrogation: \"I've got a few date windows that look good — pick one or tell me what works.\" The shell may render step-aware suggested-answer chips. Clarification chips are for gathering trip details (dates, airports, trip shape, travelers, budget). Selection chips are for choosing among options (cheapest, fastest, nonstop only). Confirmation chips are for booking actions (confirm booking, different traveler, change dates, cancel). Post-booking chips are for next actions (book hotel, add ground transport, send to calendar). If there are no plausible defaults or no decision is needed, do not imply chips; just answer plainly.\n"
        f"2. Money-moving tools (booking a flight, placing an order, reserving a hotel) require a two-step flow:\n"
        f"   a. First call the corresponding PRICING / OFFER tool (e.g. flight_price_offer). The shell will render a structured confirmation card automatically — you do NOT need to emit any `<summary>` markup yourself. Reply with ONE short sentence that introduces the card (e.g. \"Here's the final price — tap Confirm to book.\"). Do NOT recap fields the card shows (carrier, route, date, total, offer id). Do NOT ask the user for personal info (name, email, DOB, payment details) — the card is the consent gate and PII is supplied by the shell.\n"
        f"   b. Wait for the user's next message. Only call the money-moving tool AFTER the user explicitly confirms. If they decline or change the request, don't book; help them adjust.\n"
        f"3. When a tool returns selectable items that the shell renders as a rich card (flight offers → radio card; food-restaurant menu → checkbox card; reservation time slots → radio card), reply with ONE short lead-in only (e.g. \"Three nonstop options under $300 — pick one below.\" or \"Here's the menu — tap what you'd like.\" or \"Open times that night — pick one.\"). Do NOT re-list items in prose or as a markdown table — the card is the selection surface. Tools that trigger selection cards: `duffel_search_flights`, `food_get_restaurant_menu`, `restaurant_check_availability`. For flight-search or fare-lookup requests, call `duffel_search_flights`; never invent carriers, prices, or schedules in prose.\n"
        f"4. For mixed-intent turns (\"book my flight and order dinner when I land\"), sequence the tool calls yourself. Carry context across — if the user said \"Las Vegas\", the follow-up dinner order is in Las Vegas.\n"
        f"5. Never expose agent names, tool names, or technical jargon to the user. From their perspective there are no \"agents.\"\n"
        f"6. If a needed capability is not in your tool list, say plainly \"I can't do that yet,\" and suggest the closest thing you can do.\n"
        f"7. Never invent prices, PNRs, order IDs, or confirmation numbers. Only surface values you received from a tool response in the same turn.\n"
        f"8. Keep responses short by default. Long responses only when the user asks for detail.\n"
        f"9. If a tool returns an error, explain it in one sentence and offer the next step.\n"
        f"\n"
        f"Tone: concise, kind, a little dry. Think: a friend who happens to be great at logistics.\n"
        f"\n"
        f"MEMORY HYGIENE:\n"
        f"- You have three meta-tools: `memory_save`, `memory_forget`, and `profile_update`. Use them when the user tells you something worth remembering, asks you to forget something, or updates a structured preference.\n"
        f"- Save facts that will be useful LATER — preferences, allergies, recurring plans, relationships, addresses. Skip ephemeral turn-state (don't save \"wants pizza tonight\"; do save \"prefers thin crust\").\n"
        f"- Never announce that you're saving a memory in chat. The UI renders a discreet chip. If the user later asks \"what do you know about me?\" refer them to /memory.\n"
        f"- If a new fact contradicts an older one (new address, new dietary preference), pass `supersedes_id` on the memory_save so the history survives but the old fact stops ranking.\n"
        f"- Respect an explicit \"forget that\" immediately with `memory_forget` on the most recent relevant fact.\n"
        f"\n"
        f"{voice_section}"
    )


# ──────────────────────────────────────────────────────────────────────
# Agent rendering
# ──────────────────────────────────────────────────────────────────────


def _agent_line(a: AgentManifestForPrompt) -> str:
    base = f"- {a.display_name} ({a.agent_id}): {a.one_liner}"
    if a.example_utterances:
        examples = " · ".join(a.example_utterances[:3])
        return f"{base}\n    examples: {examples}"
    return base


def _unavailable_line(a: AgentManifestForPrompt) -> str:
    return f"- {a.display_name} is briefly unavailable. Do not offer it; apologize only if the user asks."


# ──────────────────────────────────────────────────────────────────────
# Memory block — mirrors formatMemoryBlock + profileToLines + addressToLine
# ──────────────────────────────────────────────────────────────────────


def _format_memory_block(memory: MemorySnapshot | None) -> str:
    if memory is None:
        return ""
    profile_lines = _profile_to_lines(memory.profile)
    fact_lines = [f"- [{f.category}] {f.fact}" for f in memory.facts]
    pattern_lines = [
        f"- {p.description} (observed {p.evidence_count}×)" for p in memory.patterns
    ]

    if not (profile_lines or fact_lines or pattern_lines):
        return ""

    parts: list[str] = ["", "WHAT YOU KNOW ABOUT THIS USER:"]
    if profile_lines:
        parts.append("  Profile:")
        for line in profile_lines:
            parts.append(f"    {line}")
    if fact_lines:
        parts.append("  Facts:")
        for line in fact_lines:
            parts.append(f"    {line}")
    if pattern_lines:
        parts.append("  Patterns:")
        for line in pattern_lines:
            parts.append(f"    {line}")
    parts.append(
        "  Use this context naturally. Do NOT recite it back verbatim. If a fact "
        "conflicts with what the user says in this turn, trust the user and emit "
        "`memory_save` with `supersedes_id` pointing at the old fact."
    )
    parts.append("")
    return "\n".join(parts)


def _profile_to_lines(p: UserProfile | None) -> list[str]:
    if p is None:
        return []
    lines: list[str] = []
    if p.display_name:
        lines.append(f"display_name: {p.display_name}")
    if p.timezone:
        lines.append(f"timezone: {p.timezone}")
    if p.preferred_language:
        lines.append(f"language: {p.preferred_language}")
    if p.home_address:
        lines.append(f"home: {_address_to_line(p.home_address)}")
    if p.work_address:
        lines.append(f"work: {_address_to_line(p.work_address)}")
    if p.dietary_flags:
        lines.append(f"dietary: {', '.join(p.dietary_flags)}")
    if p.allergies:
        lines.append(f"allergies: {', '.join(p.allergies)}")
    if p.preferred_cuisines:
        lines.append(f"cuisines: {', '.join(p.preferred_cuisines)}")
    if p.preferred_airline_class:
        lines.append(f"airline class: {p.preferred_airline_class}")
    if p.preferred_airline_seat:
        lines.append(f"seat: {p.preferred_airline_seat}")
    if p.preferred_hotel_chains:
        lines.append(f"hotel chains: {', '.join(p.preferred_hotel_chains)}")
    if p.budget_tier:
        lines.append(f"budget: {p.budget_tier}")
    if p.preferred_payment_hint:
        lines.append(f"payment: {p.preferred_payment_hint}")
    return lines


def _address_to_line(a: AddressPayload) -> str:
    parts = [v for v in (a.line1, a.city, a.region, a.country) if v]
    base = ", ".join(parts)
    return f"{a.label} — {base}" if a.label else base


# ──────────────────────────────────────────────────────────────────────
# Ambient block
# ──────────────────────────────────────────────────────────────────────


def _format_ambient_block(a: AmbientContext | None) -> str:
    if a is None:
        return ""
    lines: list[str] = []
    if a.local_time:
        lines.append(f"  local time: {a.local_time}")
    if a.timezone:
        lines.append(f"  timezone: {a.timezone}")
    if a.location_label:
        lines.append(f"  location: {a.location_label}")
    elif a.coords is not None:
        # Mirror TS .toFixed(3) + Math.round() for accuracy_m.
        coord_line = f"  coords: {a.coords.lat:.3f}, {a.coords.lng:.3f}"
        if a.coords.accuracy_m is not None:
            coord_line += f" (±{round(a.coords.accuracy_m)}m)"
        lines.append(coord_line)
    if a.device_kind:
        lines.append(f"  device: {a.device_kind}")
    if not lines:
        return ""
    return "\nRIGHT NOW:\n" + "\n".join(lines) + "\n"


# ──────────────────────────────────────────────────────────────────────
# Booking profile block — mirrors bookingProfileSnapshotToPrompt
# ──────────────────────────────────────────────────────────────────────


def _booking_profile_snapshot_to_prompt(snapshot: BookingProfileSnapshot | None) -> str:
    if snapshot is None:
        return ""
    field_lines: list[str] = []
    for key in _BOOKING_FIELD_ORDER:
        field_value = snapshot.fields.get(key)
        if field_value is None:
            # Mirror JS where snapshot.fields[key] returns undefined and
            # the .map() body would still emit a "<key>: undefined" line.
            # Production payloads always carry the full FIELD_ORDER, so
            # this is defensive rather than load-bearing.
            field_lines.append(f"- {key}: missing")
            continue
        suffix = f" ({field_value.label})" if field_value.label else ""
        field_lines.append(f"- {key}: {field_value.status}{suffix}")

    missing = list(snapshot.required_missing_fields)
    if missing:
        missing_line = (
            f"Missing required booking fields: {', '.join(missing)}. "
            "Ask only for these fields."
        )
    else:
        missing_line = (
            "All required booking fields that are in scope are present. Do not ask "
            "for name, email, phone, traveler, or payment details; proceed to the "
            "confirmation card and summarize the prefilled values."
        )
    summary_line = (
        f"Prefill summary: {snapshot.prefill_summary}" if snapshot.prefill_summary else ""
    )
    parts = [
        "",
        "BOOKING PROFILE PREFILL:",
        *field_lines,
        missing_line,
        summary_line,
        "Offer overrides when appropriate: Use my profile / Different traveler / Different payment.",
        "",
    ]
    # Match the JS .filter(Boolean) — drops empty strings only.
    return "\n".join(p for p in parts if p != "")


# ──────────────────────────────────────────────────────────────────────
# Date formatter — match JS Date.prototype.toISOString() exactly
# ──────────────────────────────────────────────────────────────────────


def _iso_string_js_compat(dt: datetime) -> str:
    """Match JS ``Date.prototype.toISOString()`` exactly: UTC, 3-digit
    millisecond precision, ``Z`` suffix.

    Python's ``datetime.isoformat()`` defaults to microsecond precision
    and a ``+00:00`` offset; this helper truncates to ms and swaps the
    offset for ``Z`` so the ``TODAY:`` line in the system prompt is
    byte-identical to TS for any given timestamp. Drift on this single
    line would dock the Levenshtein eval on every comparison.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"
