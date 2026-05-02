"""Unit tests for the per-turn suggestion-chip generator.

Pins each helper's regex match / miss / cascade behaviour plus the
top-level needsUserDecision gate, asksForFreeTextIdentity early
return, dedupe + slice(0, 4) pipeline, and the empty-list semantics
documented in recon §11.5. Calibration vs. the TS reference lives in
``test_suggestions_eval.py``.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

os.environ.setdefault("LUMO_ML_SERVICE_JWT_SECRET", "test-secret-with-at-least-thirty-two-bytes")

import pytest  # noqa: E402

from lumo_ml.plan.suggestions import build_assistant_suggestions  # noqa: E402

# Pin a known UTC date for deterministic date-suggestion output.
# 2026-05-04 is a Monday — gives clean "next Saturday" math.
_FIXED_NOW = datetime(2026, 5, 4, 12, 0, 0, tzinfo=timezone.utc)


# ──────────────────────────────────────────────────────────────────────
# needsUserDecision gate
# ──────────────────────────────────────────────────────────────────────


def test_clarification_without_question_mark_returns_empty() -> None:
    assert build_assistant_suggestions(
        assistant_text="Got it. Looking up flights.",
        planning_step="clarification",
        now=_FIXED_NOW,
    ) == []


def test_clarification_with_question_but_no_decision_keyword_returns_empty() -> None:
    # Has '?' but no pick/choose/what/which/etc.
    assert build_assistant_suggestions(
        assistant_text="Sound good?",
        planning_step="clarification",
        now=_FIXED_NOW,
    ) == []


def test_selection_without_keyword_returns_empty() -> None:
    assert build_assistant_suggestions(
        assistant_text="Here are the results.",
        planning_step="selection",
        now=_FIXED_NOW,
    ) == []


def test_confirmation_without_keyword_returns_empty() -> None:
    assert build_assistant_suggestions(
        assistant_text="All set.",
        planning_step="confirmation",
        now=_FIXED_NOW,
    ) == []


def test_post_booking_without_keyword_returns_empty() -> None:
    assert build_assistant_suggestions(
        assistant_text="See you on the flight.",
        planning_step="post_booking",
        now=_FIXED_NOW,
    ) == []


# ──────────────────────────────────────────────────────────────────────
# asksForFreeTextIdentity — clarification only, hard exit
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    [
        "What's your full name?",
        "Could you share your passport number?",
        "What's your date of birth?",
        "DOB please?",
        "Tell me the traveler names.",
        "I need the legal name on the ticket.",
    ],
)
def test_clarification_free_text_identity_returns_empty(text: str) -> None:
    assert build_assistant_suggestions(
        assistant_text=text,
        planning_step="clarification",
        now=_FIXED_NOW,
    ) == []


# ──────────────────────────────────────────────────────────────────────
# Clarification cascade — first non-empty wins
# ──────────────────────────────────────────────────────────────────────


def test_clarification_date_cascade_emits_three_chips() -> None:
    result = build_assistant_suggestions(
        assistant_text="Which dates work for you?",
        planning_step="clarification",
        now=_FIXED_NOW,
    )
    labels = [s.label for s in result]
    assert len(result) == 3
    # Mid-May 2026: Memorial Day weekend hasn't passed yet, so the third
    # seed is "Memorial Day weekend" rather than "Mid-June".
    assert labels[0].startswith("Next weekend (")
    assert labels[1].startswith("In 2 weeks (")
    assert labels[2] == "Memorial Day weekend"


def test_clarification_date_after_memorial_falls_back_to_mid_june() -> None:
    result = build_assistant_suggestions(
        assistant_text="When are you thinking?",
        planning_step="clarification",
        now=datetime(2026, 6, 15, tzinfo=timezone.utc),  # past Memorial Day
    )
    labels = [s.label for s in result]
    assert labels[2].startswith("Mid-June (")


@pytest.mark.parametrize(
    "haystack, expected_first_label",
    [
        ("chicago", "Chicago O'Hare (ORD)"),
        ("chi", "Chicago O'Hare (ORD)"),
        ("new york", "JFK"),
        ("nyc", "JFK"),
        ("manhattan", "JFK"),
        ("brooklyn", "JFK"),
        ("san francisco", "San Francisco (SFO)"),
        ("sf", "San Francisco (SFO)"),
        ("sfo", "San Francisco (SFO)"),
        ("bay area", "San Francisco (SFO)"),
    ],
)
def test_clarification_airport_branches_pick_correct_region(
    haystack: str, expected_first_label: str
) -> None:
    result = build_assistant_suggestions(
        assistant_text="Which airport should I use?",
        planning_step="clarification",
        latest_user_message=haystack,
        now=_FIXED_NOW,
    )
    assert result[0].label == expected_first_label


def test_clarification_airport_with_unknown_region_falls_through_to_next_helper() -> None:
    # Airport regex matches but no region keyword → cascade falls
    # through to tripShape / traveler / budget / comfort. None match
    # this prompt either; result is [].
    assert build_assistant_suggestions(
        assistant_text="Which airport should I use?",
        planning_step="clarification",
        latest_user_message="atlanta",
        now=_FIXED_NOW,
    ) == []


def test_clarification_trip_shape_emits_three_chips() -> None:
    result = build_assistant_suggestions(
        assistant_text="Should I look at one-way or round trip?",
        planning_step="clarification",
        now=_FIXED_NOW,
    )
    assert [s.label for s in result] == [
        "Roundtrip, 1 passenger",
        "One-way, 1 passenger",
        "Roundtrip, 2 passengers",
    ]


def test_clarification_traveler_emits_three_chips() -> None:
    result = build_assistant_suggestions(
        assistant_text="How many passengers should I plan for?",
        planning_step="clarification",
        now=_FIXED_NOW,
    )
    assert [s.label for s in result] == ["Just me", "Two travelers", "Family of four"]


def test_clarification_budget_emits_three_chips() -> None:
    result = build_assistant_suggestions(
        assistant_text="What budget should I work with?",
        planning_step="clarification",
        now=_FIXED_NOW,
    )
    assert [s.label for s in result] == ["Keep it lean", "Mid-range", "No hard limit"]


def test_clarification_comfort_emits_three_chips() -> None:
    result = build_assistant_suggestions(
        assistant_text="What should I optimize for? Tell me your priority.",
        planning_step="clarification",
        now=_FIXED_NOW,
    )
    assert [s.label for s in result] == ["Cheapest", "Fastest", "Most comfortable"]


# ──────────────────────────────────────────────────────────────────────
# Single-helper steps
# ──────────────────────────────────────────────────────────────────────


def test_selection_emits_three_chips() -> None:
    result = build_assistant_suggestions(
        assistant_text="Pick the option you like — cheapest, fastest, or nonstop?",
        planning_step="selection",
        now=_FIXED_NOW,
    )
    assert [s.label for s in result] == ["Cheapest", "Fastest", "Nonstop only"]


def test_confirmation_emits_four_chips() -> None:
    result = build_assistant_suggestions(
        assistant_text="Ready to confirm the booking? Tap below.",
        planning_step="confirmation",
        now=_FIXED_NOW,
    )
    assert [s.label for s in result] == [
        "Confirm booking",
        "Different traveler",
        "Change dates",
        "Cancel",
    ]


def test_post_booking_emits_three_chips() -> None:
    result = build_assistant_suggestions(
        assistant_text="Booked. Confirmation number on its way. What's next — hotel, ground transport?",
        planning_step="post_booking",
        now=_FIXED_NOW,
    )
    assert [s.label for s in result] == [
        "Book hotel",
        "Add ground transport",
        "Send to calendar",
    ]


# ──────────────────────────────────────────────────────────────────────
# Pipeline behaviour: id assignment, slicing, suggestion shape
# ──────────────────────────────────────────────────────────────────────


def test_chip_ids_are_s1_s2_s3_s4_in_order() -> None:
    result = build_assistant_suggestions(
        assistant_text="Ready to confirm the booking? Tap below.",
        planning_step="confirmation",
        now=_FIXED_NOW,
    )
    assert [s.id for s in result] == ["s1", "s2", "s3", "s4"]


def test_suggestion_value_field_is_populated() -> None:
    result = build_assistant_suggestions(
        assistant_text="Pick which option you want.",
        planning_step="selection",
        now=_FIXED_NOW,
    )
    assert all(s.value for s in result)
    assert result[0].value == "Pick the cheapest option"


def test_no_assistant_text_returns_empty() -> None:
    assert build_assistant_suggestions(
        assistant_text="",
        planning_step="clarification",
        now=_FIXED_NOW,
    ) == []


def test_default_planning_step_is_clarification() -> None:
    # planning_step omitted — defaults to clarification per signature.
    result = build_assistant_suggestions(
        assistant_text="Which dates work?",
        now=_FIXED_NOW,
    )
    assert len(result) == 3
    assert result[0].label.startswith("Next weekend (")


# ──────────────────────────────────────────────────────────────────────
# Date-formatter behaviour
# ──────────────────────────────────────────────────────────────────────


def test_next_weekend_from_monday_lands_on_saturday() -> None:
    # 2026-05-04 is a Monday. Next Saturday is 2026-05-09. Range is 9–11.
    result = build_assistant_suggestions(
        assistant_text="What dates work?",
        planning_step="clarification",
        now=datetime(2026, 5, 4, tzinfo=timezone.utc),
    )
    assert result[0].label == "Next weekend (May 9-11)"


def test_next_weekend_from_saturday_jumps_to_following_saturday() -> None:
    # 2026-05-09 is a Saturday — TS code's ``|| 7`` clause forces a
    # 7-day jump rather than returning today.
    result = build_assistant_suggestions(
        assistant_text="What dates work?",
        planning_step="clarification",
        now=datetime(2026, 5, 9, tzinfo=timezone.utc),
    )
    assert result[0].label == "Next weekend (May 16-18)"


def test_in_2_weeks_is_seven_days_after_next_weekend() -> None:
    result = build_assistant_suggestions(
        assistant_text="What dates work?",
        planning_step="clarification",
        now=datetime(2026, 5, 4, tzinfo=timezone.utc),
    )
    assert result[1].label == "In 2 weeks (May 16-18)"


def test_format_range_crosses_month_boundary() -> None:
    # 2026-05-29 (Friday): next Saturday is May 30, range is May 30-June 1.
    result = build_assistant_suggestions(
        assistant_text="What dates work?",
        planning_step="clarification",
        now=datetime(2026, 5, 29, tzinfo=timezone.utc),
    )
    assert result[0].label == "Next weekend (May 30-June 1)"


def test_value_format_is_full_date_to_full_date() -> None:
    result = build_assistant_suggestions(
        assistant_text="What dates work?",
        planning_step="clarification",
        now=datetime(2026, 5, 4, tzinfo=timezone.utc),
    )
    assert result[0].value == "May 9, 2026 to May 11, 2026"
