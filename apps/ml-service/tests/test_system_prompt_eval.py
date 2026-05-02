"""Calibration eval for ``build_system_prompt``.

30 fixtures in ``tests/data/system_prompt_eval.jsonl`` were generated
by running the **TypeScript** ``buildSystemPrompt`` (via
``tests/data/generate_system_prompt_eval.ts`` under tsx) on hand-
authored input scenarios. The Python port must reproduce each
output to within a Levenshtein ratio gate.

Calibration gates (per brief):
  * mean Levenshtein ratio ≥ 0.95 across all scenarios
  * per-scenario floor ≥ 0.90
  * no scenario producing an empty string (catches the regression
    where build_system_prompt returns "" silently)

Re-seeding the JSONL when TS source changes:
  cd apps/ml-service/tests/data
  npx tsx generate_system_prompt_eval.ts > system_prompt_eval.jsonl
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

os.environ.setdefault("LUMO_ML_SERVICE_JWT_SECRET", "test-secret-with-at-least-thirty-two-bytes")

import pytest  # noqa: E402

from lumo_ml.plan.schemas import (  # noqa: E402
    AgentManifestForPrompt,
    AmbientContext,
    AmbientCoords,
    BookingProfileFieldSlim,
    BookingProfileSnapshot,
    MemorySnapshot,
)
from lumo_ml.plan.system_prompt import build_system_prompt  # noqa: E402

_EVAL_PATH = Path(__file__).parent / "data" / "system_prompt_eval.jsonl"
_FIXED_NOW = datetime(2026, 5, 2, 12, 30, 45, 123_000, tzinfo=timezone.utc)

_MEAN_LEVENSHTEIN_GATE = 0.95
_PER_SCENARIO_FLOOR = 0.90


def _load_eval() -> list[dict]:
    rows: list[dict] = []
    with _EVAL_PATH.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _ratio(a: str, b: str) -> float:
    """Character-level Levenshtein ratio matching what codex's plan-
    client logger will compute server-side. ``SequenceMatcher.ratio()``
    returns 2*M / T where M is matching chars and T is total chars,
    which is the same metric the migration 058 column stores."""
    return SequenceMatcher(None, a, b).ratio()


def _coerce_agents(raw: list[dict]) -> list[AgentManifestForPrompt]:
    """The TS fixture wraps each agent in ``{manifest: {...},
    health_score: …}``; flatten to our slim AgentManifestForPrompt."""
    out: list[AgentManifestForPrompt] = []
    for entry in raw:
        m = entry["manifest"]
        out.append(
            AgentManifestForPrompt(
                display_name=m["display_name"],
                agent_id=m["agent_id"],
                one_liner=m["one_liner"],
                example_utterances=m.get("example_utterances", []),
                health_score=entry.get("health_score", 1.0),
            )
        )
    return out


def _coerce_memory(raw: dict | None) -> MemorySnapshot | None:
    if raw is None:
        return None
    return MemorySnapshot.model_validate(raw)


def _coerce_ambient(raw: dict | None) -> AmbientContext | None:
    if raw is None:
        return None
    coerced: dict = {}
    if "local_time" in raw:
        coerced["local_time"] = raw["local_time"]
    if "timezone" in raw:
        coerced["timezone"] = raw["timezone"]
    if "location_label" in raw:
        coerced["location_label"] = raw["location_label"]
    if "device_kind" in raw:
        coerced["device_kind"] = raw["device_kind"]
    if "coords" in raw:
        c = raw["coords"]
        coerced["coords"] = AmbientCoords(
            lat=c["lat"], lng=c["lng"], accuracy_m=c.get("accuracy_m")
        )
    return AmbientContext(**coerced)


def _coerce_booking(raw: dict | None) -> BookingProfileSnapshot | None:
    if raw is None:
        return None
    fields = {
        key: BookingProfileFieldSlim(
            status=val["status"],
            label=val.get("label"),
        )
        for key, val in raw["fields"].items()
    }
    return BookingProfileSnapshot(
        user_id=raw["user_id"],
        granted_scopes=raw.get("granted_scopes", []),
        fields=fields,
        required_missing_fields=raw.get("required_missing_fields", []),
        prefill_summary=raw.get("prefill_summary"),
    )


def _run_python(input_dict: dict) -> str:
    return build_system_prompt(
        agents=_coerce_agents(input_dict.get("agents", [])),
        now=_FIXED_NOW,
        user_region=input_dict.get("user_region", "US"),
        user_first_name=input_dict.get("user_first_name"),
        mode=input_dict.get("mode", "text"),
        memory=_coerce_memory(input_dict.get("memory")),
        ambient=_coerce_ambient(input_dict.get("ambient")),
        booking_profile=_coerce_booking(input_dict.get("bookingProfile")),
    )


def test_eval_corpus_size_at_least_25() -> None:
    rows = _load_eval()
    assert len(rows) >= 25, (
        f"Eval corpus has {len(rows)} rows; brief mandates ≥25."
    )


def test_calibration_meets_levenshtein_gates() -> None:
    rows = _load_eval()

    per_scenario: list[tuple[str, float]] = []
    floor_violations: list[tuple[str, float]] = []
    empty_violations: list[str] = []

    for row in rows:
        actual = _run_python(row["input"])
        if not actual:
            empty_violations.append(row["id"])
            continue
        ratio = _ratio(actual, row["expected"])
        per_scenario.append((row["id"], ratio))
        if ratio < _PER_SCENARIO_FLOOR:
            floor_violations.append((row["id"], ratio))

    failures: list[str] = []
    if empty_violations:
        failures.append(
            "Scenarios produced empty Python output:\n"
            + "\n".join(f"  - {tid}" for tid in empty_violations)
        )
    if floor_violations:
        floor_lines = "\n".join(
            f"  - {tid}: ratio {score:.4f}" for tid, score in floor_violations
        )
        failures.append(
            f"Per-scenario Levenshtein floor {_PER_SCENARIO_FLOOR:.0%} violated:\n{floor_lines}"
        )

    mean = (
        sum(score for _, score in per_scenario) / len(per_scenario)
        if per_scenario
        else 0.0
    )
    if mean < _MEAN_LEVENSHTEIN_GATE:
        failures.append(
            f"Mean Levenshtein {mean:.4f} below gate {_MEAN_LEVENSHTEIN_GATE:.0%}"
        )

    if failures:
        pytest.fail("\n\n".join(failures))


def test_no_scenario_returns_empty_string() -> None:
    """Brief acceptance: 'no scenario returning empty string'.
    Defended explicitly because mean Levenshtein could clear 0.95
    while a few scenarios silently emit ''. This catches the
    regression where the Python port short-circuits."""
    rows = _load_eval()
    empties: list[str] = []
    for row in rows:
        actual = _run_python(row["input"])
        if not actual.strip():
            empties.append(row["id"])
    assert not empties, f"Empty Python output on: {empties}"
