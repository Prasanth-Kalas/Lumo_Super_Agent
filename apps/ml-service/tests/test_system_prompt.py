"""Unit tests for ``build_system_prompt`` and its helpers.

Pins each section's structure independently so a regression in one
helper (e.g. memory block formatting) doesn't drift the whole prompt
silently. Calibration vs. the TS reference lives in
``test_system_prompt_eval.py``.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

os.environ.setdefault("LUMO_ML_SERVICE_JWT_SECRET", "test-secret-with-at-least-thirty-two-bytes")

from lumo_ml.plan.schemas import (  # noqa: E402
    AddressPayload,
    AgentManifestForPrompt,
    AmbientContext,
    AmbientCoords,
    BehaviorPattern,
    BookingProfileFieldSlim,
    BookingProfileSnapshot,
    MemorySnapshot,
    UserFact,
    UserProfile,
)
from lumo_ml.plan.system_prompt import (  # noqa: E402
    _format_ambient_block,
    _format_memory_block,
    _iso_string_js_compat,
    _profile_to_lines,
    build_system_prompt,
)
from lumo_ml.plan.voice_format import VOICE_MODE_PROMPT  # noqa: E402

_NOW = datetime(2026, 5, 2, 12, 30, 45, 123_000, tzinfo=timezone.utc)
_AGENT = AgentManifestForPrompt(
    display_name="Flight Agent",
    agent_id="lumo.flight",
    one_liner="Search and book flights",
    example_utterances=["Show me flights to Vegas"],
    health_score=1.0,
)


# ──────────────────────────────────────────────────────────────────────
# JS-compat ISO-string helper
# ──────────────────────────────────────────────────────────────────────


def test_iso_string_matches_js_format() -> None:
    """JS Date.toISOString() emits 3-digit ms + Z; we must match
    exactly so the TODAY: line in the prompt doesn't drift the
    Levenshtein score on every comparison."""
    dt = datetime(2026, 5, 2, 12, 30, 45, 123_000, tzinfo=timezone.utc)
    assert _iso_string_js_compat(dt) == "2026-05-02T12:30:45.123Z"


def test_iso_string_naive_treated_as_utc() -> None:
    naive = datetime(2026, 1, 1, 0, 0, 0)
    assert _iso_string_js_compat(naive) == "2026-01-01T00:00:00.000Z"


def test_iso_string_truncates_to_milliseconds() -> None:
    """Python defaults to microsecond precision (6 digits); JS uses
    millisecond (3 digits). Our helper must truncate not round."""
    dt = datetime(2026, 5, 2, 12, 30, 45, 999_999, tzinfo=timezone.utc)
    assert _iso_string_js_compat(dt) == "2026-05-02T12:30:45.999Z"


def test_iso_string_normalizes_offset_to_utc() -> None:
    from datetime import timedelta
    pst = timezone(timedelta(hours=-8))
    dt = datetime(2026, 5, 2, 4, 30, 45, 123_000, tzinfo=pst)
    assert _iso_string_js_compat(dt) == "2026-05-02T12:30:45.123Z"


# ──────────────────────────────────────────────────────────────────────
# Top-level structure
# ──────────────────────────────────────────────────────────────────────


def test_minimal_prompt_contains_required_lines() -> None:
    prompt = build_system_prompt(
        agents=[_AGENT], now=_NOW, user_region="US",
    )
    assert "You are Lumo, a universal personal concierge." in prompt
    assert "TODAY: 2026-05-02T12:30:45.123Z" in prompt
    assert "USER REGION: US" in prompt
    assert "CAPABILITIES YOU HAVE (via tools):" in prompt
    assert "RULES:" in prompt
    assert "Tone: concise, kind, a little dry." in prompt
    assert "MEMORY HYGIENE:" in prompt


def test_user_first_name_emits_user_line_when_present() -> None:
    with_name = build_system_prompt(
        agents=[_AGENT], now=_NOW, user_region="US", user_first_name="Alex",
    )
    without = build_system_prompt(
        agents=[_AGENT], now=_NOW, user_region="US",
    )
    assert "USER: Alex" in with_name
    assert "USER:" not in without


def test_voice_mode_appends_voice_block() -> None:
    text_prompt = build_system_prompt(agents=[_AGENT], now=_NOW, user_region="US")
    voice_prompt = build_system_prompt(
        agents=[_AGENT], now=_NOW, user_region="US", mode="voice",
    )
    assert "VOICE MODE:" not in text_prompt
    assert "VOICE MODE:" in voice_prompt
    assert VOICE_MODE_PROMPT in voice_prompt


def test_voice_mode_prompt_starts_and_ends_clean() -> None:
    """Sanity-check the constant — TS uses .trim() and we use
    .strip() on the literal, so neither side should leak whitespace."""
    assert VOICE_MODE_PROMPT == VOICE_MODE_PROMPT.strip()
    assert VOICE_MODE_PROMPT.startswith("You are in VOICE mode.")
    assert VOICE_MODE_PROMPT.endswith("users shouldn't speak these).")


def test_no_agents_emits_placeholder_line() -> None:
    prompt = build_system_prompt(agents=[], now=_NOW, user_region="US")
    assert "(none currently registered)" in prompt


def test_unhealthy_agents_emit_unavailable_block() -> None:
    healthy = AgentManifestForPrompt(
        display_name="A", agent_id="a", one_liner="A.", health_score=1.0,
    )
    sick = AgentManifestForPrompt(
        display_name="Bot", agent_id="b", one_liner="B.", health_score=0.4,
    )
    prompt = build_system_prompt(agents=[healthy, sick], now=_NOW, user_region="US")
    assert "CURRENTLY UNAVAILABLE:" in prompt
    assert "Bot is briefly unavailable" in prompt


def test_all_healthy_omits_unavailable_block() -> None:
    healthy = AgentManifestForPrompt(
        display_name="A", agent_id="a", one_liner="A.", health_score=1.0,
    )
    prompt = build_system_prompt(agents=[healthy], now=_NOW, user_region="US")
    assert "CURRENTLY UNAVAILABLE:" not in prompt


def test_agent_examples_capped_at_three() -> None:
    a = AgentManifestForPrompt(
        display_name="A", agent_id="a", one_liner="A.",
        example_utterances=["one", "two", "three", "four", "five"],
        health_score=1.0,
    )
    prompt = build_system_prompt(agents=[a], now=_NOW, user_region="US")
    assert "examples: one · two · three" in prompt
    assert "four" not in prompt


def test_agent_no_examples_omits_examples_line() -> None:
    a = AgentManifestForPrompt(
        display_name="Quiet", agent_id="q", one_liner="No examples.",
        example_utterances=[],
        health_score=1.0,
    )
    prompt = build_system_prompt(agents=[a], now=_NOW, user_region="US")
    assert "Quiet (q): No examples." in prompt
    assert "examples:" not in prompt


# ──────────────────────────────────────────────────────────────────────
# Memory block
# ──────────────────────────────────────────────────────────────────────


def test_format_memory_block_returns_empty_when_no_memory() -> None:
    assert _format_memory_block(None) == ""
    empty = MemorySnapshot(profile=None, facts=[], patterns=[])
    assert _format_memory_block(empty) == ""


def test_format_memory_block_renders_profile_section() -> None:
    profile = UserProfile(
        id="u",
        display_name="Alex",
        timezone="UTC",
        preferred_language=None,
        home_address=None,
        work_address=None,
        dietary_flags=[],
        allergies=["peanuts"],
        preferred_cuisines=[],
        preferred_airline_class=None,
        preferred_airline_seat=None,
        preferred_hotel_chains=[],
        budget_tier=None,
        preferred_payment_hint=None,
    )
    block = _format_memory_block(MemorySnapshot(profile=profile, facts=[], patterns=[]))
    assert "WHAT YOU KNOW ABOUT THIS USER:" in block
    assert "Profile:" in block
    assert "    display_name: Alex" in block
    assert "    timezone: UTC" in block
    assert "    allergies: peanuts" in block
    assert "language" not in block  # null fields skipped


def test_format_memory_block_renders_facts_section() -> None:
    facts = [
        UserFact(id="f1", fact="loves window seats", category="preference"),
        UserFact(id="f2", fact="spouse name is Jordan", category="identity"),
    ]
    block = _format_memory_block(MemorySnapshot(profile=None, facts=facts, patterns=[]))
    assert "  Facts:" in block
    assert "    - [preference] loves window seats" in block
    assert "    - [identity] spouse name is Jordan" in block


def test_format_memory_block_renders_patterns_section() -> None:
    patterns = [
        BehaviorPattern(id="p1", description="books 2 weeks ahead", evidence_count=7),
    ]
    block = _format_memory_block(
        MemorySnapshot(profile=None, facts=[], patterns=patterns)
    )
    assert "  Patterns:" in block
    assert "    - books 2 weeks ahead (observed 7×)" in block


def test_profile_to_lines_skips_null_fields() -> None:
    profile = UserProfile(
        id="u",
        display_name="Sam",
        timezone=None,
        preferred_language=None,
        home_address=None,
        work_address=None,
        dietary_flags=[],
        allergies=[],
        preferred_cuisines=[],
        preferred_airline_class=None,
        preferred_airline_seat=None,
        preferred_hotel_chains=[],
        budget_tier=None,
        preferred_payment_hint=None,
    )
    lines = _profile_to_lines(profile)
    assert lines == ["display_name: Sam"]


def test_profile_to_lines_renders_address_with_label() -> None:
    profile = UserProfile(
        id="u",
        display_name=None,
        timezone=None,
        preferred_language=None,
        home_address=AddressPayload(
            label="Home", line1="123 Main", city="Chicago", region="IL", country="US",
        ),
        work_address=None,
        dietary_flags=[],
        allergies=[],
        preferred_cuisines=[],
        preferred_airline_class=None,
        preferred_airline_seat=None,
        preferred_hotel_chains=[],
        budget_tier=None,
        preferred_payment_hint=None,
    )
    lines = _profile_to_lines(profile)
    assert lines == ["home: Home — 123 Main, Chicago, IL, US"]


# ──────────────────────────────────────────────────────────────────────
# Ambient block
# ──────────────────────────────────────────────────────────────────────


def test_format_ambient_block_returns_empty_when_no_ambient() -> None:
    assert _format_ambient_block(None) == ""
    assert _format_ambient_block(AmbientContext()) == ""


def test_format_ambient_block_renders_full_context() -> None:
    ctx = AmbientContext(
        local_time="2026-05-02T05:30:45-07:00",
        timezone="America/Los_Angeles",
        location_label="San Francisco",
        device_kind="ios",
    )
    block = _format_ambient_block(ctx)
    assert block.startswith("\nRIGHT NOW:")
    assert "  local time: 2026-05-02T05:30:45-07:00" in block
    assert "  timezone: America/Los_Angeles" in block
    assert "  location: San Francisco" in block
    assert "  device: ios" in block


def test_ambient_coords_used_when_no_location_label() -> None:
    ctx = AmbientContext(coords=AmbientCoords(lat=37.7749, lng=-122.4194, accuracy_m=12))
    block = _format_ambient_block(ctx)
    assert "  coords: 37.775, -122.419 (±12m)" in block


def test_ambient_location_label_takes_precedence_over_coords() -> None:
    ctx = AmbientContext(
        location_label="SF", coords=AmbientCoords(lat=37.7749, lng=-122.4194),
    )
    block = _format_ambient_block(ctx)
    assert "location: SF" in block
    assert "coords:" not in block


# ──────────────────────────────────────────────────────────────────────
# Booking-profile block
# ──────────────────────────────────────────────────────────────────────


def test_booking_profile_block_renders_present_fields() -> None:
    snapshot = BookingProfileSnapshot(
        user_id="u",
        granted_scopes=[],
        fields={
            "name": BookingProfileFieldSlim(status="present", label="Alex Doe"),
            "email": BookingProfileFieldSlim(status="present", label="a@b.com"),
            "phone": BookingProfileFieldSlim(status="missing"),
            "payment_method_id": BookingProfileFieldSlim(status="missing"),
            "traveler_profile": BookingProfileFieldSlim(status="missing"),
            "passport": BookingProfileFieldSlim(status="not_in_scope"),
            "passport_optional": BookingProfileFieldSlim(status="not_in_scope"),
            "dob": BookingProfileFieldSlim(status="missing"),
        },
        required_missing_fields=["phone", "payment_method_id", "dob"],
        prefill_summary=None,
    )
    prompt = build_system_prompt(
        agents=[_AGENT], now=_NOW, user_region="US",
        booking_profile=snapshot,
    )
    assert "BOOKING PROFILE PREFILL:" in prompt
    assert "- name: present (Alex Doe)" in prompt
    assert "- phone: missing" in prompt
    assert (
        "Missing required booking fields: phone, payment_method_id, dob. "
        "Ask only for these fields."
    ) in prompt


def test_booking_profile_block_no_missing_emits_done_line() -> None:
    snapshot = BookingProfileSnapshot(
        user_id="u",
        granted_scopes=[],
        fields={
            "name": BookingProfileFieldSlim(status="present", label="Alex"),
            "email": BookingProfileFieldSlim(status="present", label="a@b.com"),
            "phone": BookingProfileFieldSlim(status="present", label="+1"),
            "payment_method_id": BookingProfileFieldSlim(status="present", label="Visa"),
            "traveler_profile": BookingProfileFieldSlim(status="present"),
            "passport": BookingProfileFieldSlim(status="not_in_scope"),
            "passport_optional": BookingProfileFieldSlim(status="not_in_scope"),
            "dob": BookingProfileFieldSlim(status="present", label="1990-01-01"),
        },
        required_missing_fields=[],
        prefill_summary="Alex Doe — a@b.com",
    )
    prompt = build_system_prompt(
        agents=[_AGENT], now=_NOW, user_region="US",
        booking_profile=snapshot,
    )
    assert "All required booking fields that are in scope are present." in prompt
    assert "Prefill summary: Alex Doe — a@b.com" in prompt
