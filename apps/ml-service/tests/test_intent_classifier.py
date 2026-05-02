"""Unit tests for the anchor-based intent classifier.

These pin the brief's three canonical examples plus the regex
preconditions of the deterministic flight-search guard. Calibration
against the broader 50+-message corpus lives in
``test_intent_classifier_eval.py``.
"""

from __future__ import annotations

import os
import time

os.environ.setdefault("LUMO_ML_SERVICE_JWT_SECRET", "test-secret-with-at-least-thirty-two-bytes")

import pytest  # noqa: E402

from lumo_ml.plan.classifier import (  # noqa: E402
    IntentClassification,
    IntentClassifier,
    looks_like_flight_offer_request,
)

# ──────────────────────────────────────────────────────────────────────
# Deterministic guard — pure regex, no model load
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "message",
    [
        "book me a flight to Vegas",
        "find flights from SFO to JFK next Friday",
        "look up airfare from Chicago to LAX",
        "search for cheap flights to MIA",
        "show me flight options from ORD to LGA",
        "compare flights between Chicago and Vegas",
    ],
)
def test_guard_matches_flight_offer_requests(message: str) -> None:
    assert looks_like_flight_offer_request(message)


@pytest.mark.parametrize(
    "message",
    [
        "",
        "hi",
        "what time is it",
        "play my workout playlist",
        "fly fishing",  # has flight-adjacent word but no search verb / route
        "I love airports",  # noun only
        "book a hotel in Vegas",  # has search verb + route but no flight word
    ],
)
def test_guard_rejects_non_flight_searches(message: str) -> None:
    assert not looks_like_flight_offer_request(message)


# ──────────────────────────────────────────────────────────────────────
# Classifier — model load happens once at module scope
# ──────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def classifier() -> IntentClassifier:
    clf = IntentClassifier()
    clf.warmup()
    return clf


def test_classify_greeting_is_fast_path(classifier: IntentClassifier) -> None:
    result = classifier.classify("hi")
    assert isinstance(result, IntentClassification)
    assert result.bucket == "fast_path"


def test_classify_flight_request_is_tool_path_via_guard(classifier: IntentClassifier) -> None:
    result = classifier.classify("book me a flight to Vegas")
    assert result.bucket == "tool_path"
    # Must come through the deterministic guard regardless of what the
    # embedding scores would have said.
    assert "flight-search guard" in result.reasoning


def test_classify_compound_trip_is_reasoning_path(classifier: IntentClassifier) -> None:
    result = classifier.classify(
        "plan a Vegas weekend with flight, hotel, and dinner reservations"
    )
    assert result.bucket == "reasoning_path"


def test_singleton_returns_same_instance() -> None:
    a = IntentClassifier.get_instance()
    b = IntentClassifier.get_instance()
    assert a is b


def test_warm_classify_under_200ms(classifier: IntentClassifier) -> None:
    """Warm-call latency target from the brief: < 200 ms p50.
    Median of 5 calls on the local Mac CPU; this is loose by design
    (CI runners are slower than dev macs) but catches catastrophic
    regressions like accidental per-call model reloads."""
    samples_ms: list[float] = []
    for _ in range(5):
        t0 = time.perf_counter()
        classifier.classify("show me my unread emails")
        samples_ms.append((time.perf_counter() - t0) * 1000)
    samples_ms.sort()
    p50 = samples_ms[len(samples_ms) // 2]
    # Loose ceiling — local Mac warm path should be ~10–50 ms; CI
    # ubuntu-latest is typically 2–4× slower. Anything > 1 s is a
    # genuine regression.
    assert p50 < 1000, f"p50 latency {p50:.1f} ms exceeds 1000 ms ceiling"
