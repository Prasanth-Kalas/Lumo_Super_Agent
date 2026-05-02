"""Calibration eval for the anchor-based intent classifier.

50+ canonical messages, expected bucket per the TS reference's
behaviour (``apps/web/lib/perf/intent-classifier.ts`` system prompt
+ deterministic flight-search guard). The lane gate is **≥85 %
agreement** — drops below that should not merge until anchors are
re-tuned.

This test is slow (~3–8 s) because it loads the sentence-encoder
once. It runs in the standard ``pytest apps/ml-service/tests/`` suite
because the classifier is now production code path; if local-dev
iteration is too slow, the encoder is cached after the first run via
huggingface-hub's local cache.
"""

from __future__ import annotations

import os

os.environ.setdefault("LUMO_ML_SERVICE_JWT_SECRET", "test-secret-with-at-least-thirty-two-bytes")

import pytest

from lumo_ml.plan.classifier import Bucket, IntentClassifier  # noqa: E402

# (message, expected_bucket) — keep alphabetised within each section
# for diff stability.

EVAL_CASES: list[tuple[str, Bucket]] = [
    # ─── fast_path: simple Q&A, greetings, rewrites, conversions ─────
    ("hi", "fast_path"),
    ("hello", "fast_path"),
    ("hey there", "fast_path"),
    ("thanks!", "fast_path"),
    ("good morning", "fast_path"),
    ("what time is it", "fast_path"),
    ("what's the capital of France", "fast_path"),
    ("define photosynthesis in one sentence", "fast_path"),
    ("explain HTTP status codes briefly", "fast_path"),
    ("how do you spell accommodation", "fast_path"),
    ("rewrite this to be shorter: I am writing to inform you", "fast_path"),
    ("translate hello to Japanese", "fast_path"),
    ("what does HTTP stand for", "fast_path"),
    ("convert 50 USD to euros", "fast_path"),
    ("summarize this paragraph in two lines", "fast_path"),
    ("what is 2 plus 2", "fast_path"),
    ("explain what an API is", "fast_path"),
    # ─── tool_path: 1–3 tool / agent calls, light reasoning ─────────
    ("show me my unread emails", "tool_path"),
    ("find a sushi restaurant near me", "tool_path"),
    ("book me a flight to Vegas", "tool_path"),
    ("look up flights from SFO to JFK next Friday", "tool_path"),
    ("show flights ORD to MIA tomorrow", "tool_path"),
    ("what's the weather in Chicago tomorrow", "tool_path"),
    ("send a message to my landlord", "tool_path"),
    ("play my workout playlist", "tool_path"),
    ("set a reminder for 5pm to call mom", "tool_path"),
    ("search my notes for the partnership idea", "tool_path"),
    ("find an EV charger nearby", "tool_path"),
    ("show me events near me this weekend", "tool_path"),
    ("find me a hotel in Vegas for two nights", "tool_path"),
    ("what's on my calendar tomorrow", "tool_path"),
    ("order pizza from the place I usually order from", "tool_path"),
    ("book a table at Nobu for 8pm", "tool_path"),
    ("find me an airline ticket from NYC to LAX next month", "tool_path"),
    # ─── reasoning_path: multi-step plans, money, decisions ─────────
    ("plan a Vegas weekend with flight, hotel, and dinner reservations", "reasoning_path"),
    ("plan a 3-day trip to Tokyo including hotel, flights, and a sushi tasting", "reasoning_path"),
    ("should I refinance my mortgage given current rates", "reasoning_path"),
    ("help me decide which of these five apartments to rent", "reasoning_path"),
    ("compare these three job offers and recommend one", "reasoning_path"),
    ("design a two-week travel itinerary across Europe under $3000", "reasoning_path"),
    ("should I sell my Apple stock this quarter", "reasoning_path"),
    ("help me draft a multi-step launch plan for my product", "reasoning_path"),
    ("review this contract and flag risky clauses", "reasoning_path"),
    ("I want to buy a house — walk me through the offer process", "reasoning_path"),
    ("evaluate whether I should take this job in another city", "reasoning_path"),
    ("plan my retirement portfolio rebalance for the year", "reasoning_path"),
    ("given my receipts this year, build me a budget for next year", "reasoning_path"),
    ("plan a wedding for 80 guests with venue, catering, and music", "reasoning_path"),
    ("help me think through whether to start my own company", "reasoning_path"),
    ("draft an investment plan for $50000 across stocks and bonds", "reasoning_path"),
    ("compare and contrast these four insurance policies", "reasoning_path"),
]


@pytest.fixture(scope="module")
def classifier() -> IntentClassifier:
    clf = IntentClassifier()
    clf.warmup()
    return clf


CALIBRATION_THRESHOLD = 0.85


def test_eval_corpus_size_at_least_50() -> None:
    # The brief specifies 50+ canonical messages. Sanity-check that we
    # don't accidentally trim below the floor when re-tuning.
    assert len(EVAL_CASES) >= 50, f"Eval corpus has {len(EVAL_CASES)} cases; need ≥50."


def test_eval_corpus_covers_every_bucket() -> None:
    buckets = {bucket for _, bucket in EVAL_CASES}
    assert buckets == {"fast_path", "tool_path", "reasoning_path"}


def test_classifier_calibration(classifier: IntentClassifier) -> None:
    """Classifier must agree with the TS reference on ≥85 % of canonical
    messages. Failure mode: list every disagreement so the next anchor-
    tuning iteration knows what's drifting."""
    disagreements: list[tuple[str, Bucket, Bucket, float]] = []
    for message, expected in EVAL_CASES:
        result = classifier.classify(message)
        if result.bucket != expected:
            disagreements.append((message, expected, result.bucket, result.confidence))

    total = len(EVAL_CASES)
    correct = total - len(disagreements)
    agreement = correct / total

    if agreement < CALIBRATION_THRESHOLD:
        diff_lines = "\n".join(
            f"  - {msg!r}: expected={exp}, got={got} (conf={conf:.2f})"
            for msg, exp, got, conf in disagreements
        )
        pytest.fail(
            f"Classifier agreement {agreement:.1%} ({correct}/{total}) "
            f"below threshold {CALIBRATION_THRESHOLD:.0%}.\n"
            f"Disagreements:\n{diff_lines}"
        )


def test_per_bucket_recall_at_least_70_pct(classifier: IntentClassifier) -> None:
    """Even if total agreement clears 85 %, every bucket must hit ≥70 %
    recall — otherwise the classifier is biased toward whichever bucket
    has the most eval cases."""
    by_bucket_total: dict[Bucket, int] = {"fast_path": 0, "tool_path": 0, "reasoning_path": 0}
    by_bucket_correct: dict[Bucket, int] = {"fast_path": 0, "tool_path": 0, "reasoning_path": 0}
    for message, expected in EVAL_CASES:
        by_bucket_total[expected] += 1
        if classifier.classify(message).bucket == expected:
            by_bucket_correct[expected] += 1

    weak: list[tuple[Bucket, int, int]] = []
    for bucket in by_bucket_total:
        total = by_bucket_total[bucket]
        if total == 0:
            continue
        recall = by_bucket_correct[bucket] / total
        if recall < 0.70:
            weak.append((bucket, by_bucket_correct[bucket], total))

    if weak:
        weak_lines = "\n".join(
            f"  - {bucket}: {correct}/{total} ({correct / total:.1%})"
            for bucket, correct, total in weak
        )
        pytest.fail(f"Per-bucket recall below 70 %:\n{weak_lines}")
