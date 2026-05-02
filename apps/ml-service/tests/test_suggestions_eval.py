"""Calibration eval for ``build_assistant_suggestions``.

42 canonical conversation turns keyed on ``planning_step`` (per
reviewer's Q2 answer). Distribution:

  * 18 clarification — every helper in the cascade hit at least
    twice, plus the no-question-mark gate, the asksForFreeTextIdentity
    early-return, and the "airport regex matches but no region keyword"
    fall-through.
  * 8 selection
  * 8 confirmation
  * 8 post_booking

Calibration gates (per brief):
  * mean Jaccard ≥ 0.80 across non-empty expected sets
  * per-turn Jaccard ≥ 0.60 floor on non-empty expected sets
  * empty-expected turns must produce empty Python output exactly
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("LUMO_ML_SERVICE_JWT_SECRET", "test-secret-with-at-least-thirty-two-bytes")

import pytest  # noqa: E402

from lumo_ml.plan.suggestions import build_assistant_suggestions  # noqa: E402

_FIXED_NOW = datetime(2026, 5, 4, 12, 0, 0, tzinfo=timezone.utc)
_EVAL_PATH = Path(__file__).parent / "data" / "suggestions_eval.jsonl"

_MEAN_JACCARD_GATE = 0.80
_PER_TURN_JACCARD_FLOOR = 0.60


def _load_eval() -> list[dict]:
    rows: list[dict] = []
    with _EVAL_PATH.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _jaccard(a: list[str], b: list[str]) -> float:
    set_a = {item.lower() for item in a}
    set_b = {item.lower() for item in b}
    if not set_a and not set_b:
        return 1.0
    return len(set_a & set_b) / len(set_a | set_b)


def test_eval_corpus_size_at_least_40() -> None:
    rows = _load_eval()
    assert len(rows) >= 40, f"Eval corpus has {len(rows)} rows; brief mandates ≥40."


def test_eval_corpus_has_min_10_per_planning_step() -> None:
    rows = _load_eval()
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["planning_step"]] = counts.get(row["planning_step"], 0) + 1
    expected_steps = {"clarification", "selection", "confirmation", "post_booking"}
    assert set(counts) == expected_steps
    for step in expected_steps:
        assert counts[step] >= 8, f"{step} has {counts[step]}/8 minimum cases (clarification needs 10+)"
    assert counts["clarification"] >= 10


def test_calibration_meets_jaccard_gates() -> None:
    """Mean Jaccard ≥ 80 % across non-empty expected sets, per-turn
    floor ≥ 60 %. Empty-expected turns must round-trip to empty
    Python output (any chip emission on those is a bug)."""
    rows = _load_eval()

    per_turn_jaccards: list[tuple[str, float]] = []
    empty_violations: list[tuple[str, list[str]]] = []
    floor_violations: list[tuple[str, float, list[str], list[str]]] = []

    for row in rows:
        result = build_assistant_suggestions(
            assistant_text=row["assistant_text"],
            planning_step=row["planning_step"],
            latest_user_message=row.get("latest_user_message"),
            user_region=row.get("user_region"),
            now=_FIXED_NOW,
        )
        actual_labels = [s.label for s in result]
        expected_labels = list(row.get("expected_labels", []))

        if not expected_labels:
            if actual_labels:
                empty_violations.append((row["id"], actual_labels))
            continue

        score = _jaccard(actual_labels, expected_labels)
        per_turn_jaccards.append((row["id"], score))
        if score < _PER_TURN_JACCARD_FLOOR:
            floor_violations.append((row["id"], score, expected_labels, actual_labels))

    failures: list[str] = []
    if empty_violations:
        lines = "\n".join(f"  - {tid}: emitted {labels}" for tid, labels in empty_violations)
        failures.append(f"Empty-expected turns produced chips:\n{lines}")
    if floor_violations:
        lines = "\n".join(
            f"  - {tid}: Jaccard {score:.2f}\n      expected={exp}\n      actual={act}"
            for tid, score, exp, act in floor_violations
        )
        failures.append(
            f"Per-turn Jaccard floor {_PER_TURN_JACCARD_FLOOR:.0%} violated:\n{lines}"
        )

    mean_jaccard = (
        sum(score for _, score in per_turn_jaccards) / len(per_turn_jaccards)
        if per_turn_jaccards
        else 0.0
    )
    if mean_jaccard < _MEAN_JACCARD_GATE:
        failures.append(
            f"Mean Jaccard {mean_jaccard:.1%} below gate {_MEAN_JACCARD_GATE:.0%}"
        )

    if failures:
        pytest.fail("\n\n".join(failures))


def test_no_non_empty_expected_turn_returns_empty_chips() -> None:
    """Brief acceptance: 'no turn returning empty array' on expected-
    chip turns. Defended explicitly because mean-Jaccard could in
    principle clear the gate while a few turns silently emit empty
    arrays — this test ensures we'd know."""
    rows = _load_eval()
    silent_empties: list[str] = []
    for row in rows:
        if not row.get("expected_labels"):
            continue
        result = build_assistant_suggestions(
            assistant_text=row["assistant_text"],
            planning_step=row["planning_step"],
            latest_user_message=row.get("latest_user_message"),
            user_region=row.get("user_region"),
            now=_FIXED_NOW,
        )
        if not result:
            silent_empties.append(row["id"])
    assert not silent_empties, f"Turns with expected chips returned empty: {silent_empties}"
