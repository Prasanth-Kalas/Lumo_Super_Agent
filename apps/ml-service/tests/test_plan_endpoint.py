"""Tests for the /api/tools/plan stub endpoint and its schemas.

MLSERVICE-PLAN-CONTRACT-1 — Phase 0 contract. The endpoint returns a
fixed stub body in this lane; Phase 1 (INTENT-CLASSIFIER-MIGRATE-
PYTHON-1) will swap the body for real classification but keep the
wire shape stable, signalled by the X-Lumo-Plan-Stub: 1 header
dropping.
"""

from __future__ import annotations

import os
import time

import jwt
import pytest
from fastapi.testclient import TestClient

TEST_SECRET = "test-secret-with-at-least-thirty-two-bytes"

os.environ.setdefault("LUMO_ML_SERVICE_JWT_SECRET", TEST_SECRET)
os.environ.setdefault("LUMO_ML_PUBLIC_BASE_URL", "http://localhost:3010")

from lumo_ml.main import app  # noqa: E402
from lumo_ml.plan.router import (  # noqa: E402
    CONFIDENCE_HEADER_NAME,
    GAP_HEADER_NAME,
    STUB_HEADER_NAME,
    STUB_HEADER_VALUE,
    TOP_SCORE_HEADER_NAME,
)
from lumo_ml.plan.schemas import (  # noqa: E402
    ChatTurn,
    CompoundMissionLeg,
    CompoundMissionPlan,
    PlanRequest,
    PlanResponse,
    ProfileSummaryHints,
    Suggestion,
)

client = TestClient(app)


def _token(scope: str = "lumo.plan") -> str:
    return jwt.encode(
        {
            "iss": "lumo-core",
            "aud": "lumo-ml",
            "sub": "user_123",
            "jti": "req_plan_test",
            "scope": scope,
            "exp": int(time.time()) + 60,
        },
        TEST_SECRET,
        algorithm="HS256",
    )


def _auth_headers(scope: str = "lumo.plan") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(scope)}"}


# ────────────────────────────────────────────────────────────────────
# Schema round-trip
# ────────────────────────────────────────────────────────────────────


def test_plan_request_minimal_round_trip() -> None:
    minimal = {
        "user_message": "hi",
        "session_id": "sess_1",
        "user_id": "anon",
    }
    req = PlanRequest.model_validate(minimal)
    dumped = req.model_dump()
    # Defaults populate the optional list/None fields.
    assert dumped["history"] == []
    assert dumped["approvals"] == []
    assert dumped["planning_step_hint"] is None
    # Round-trip preserves the payload's required keys.
    for key, value in minimal.items():
        assert dumped[key] == value


def test_plan_request_maximal_round_trip() -> None:
    maximal = {
        "user_message": "Plan a Vegas trip with flight + hotel",
        "session_id": "sess_42",
        "user_id": "user_999",
        "history": [
            {"role": "user", "content": "I want to go to Vegas"},
            {"role": "assistant", "content": "Sure — when?"},
        ],
        "approvals": [
            {
                "user_id": "user_999",
                "session_id": "sess_42",
                "agent_id": "lumo-flight",
                "granted_scopes": ["search", "book"],
                "approved_at": "2026-05-02T00:00:00Z",
                "connected_at": "2026-05-02T00:00:01Z",
                "connection_provider": "duffel",
            }
        ],
        "planning_step_hint": "selection",
        # SUGGESTIONS-MIGRATE-PYTHON-1: optional input the
        # orchestrator passes when /plan is called post-LLM (or with a
        # replayed turn) so the suggestion-chip cascade has assistant
        # text to score against.
        "last_assistant_message": "Pick the cheapest, fastest, or nonstop option.",
    }
    req = PlanRequest.model_validate(maximal)
    dumped = req.model_dump(mode="json")
    assert dumped == maximal


def test_plan_response_round_trip_full() -> None:
    full = PlanResponse(
        intent_bucket="reasoning_path",
        planning_step="confirmation",
        suggestions=[
            Suggestion(id="s1", label="Next weekend", value="next weekend"),
            Suggestion(id="s2", label="Chicago O'Hare", value="ORD"),
        ],
        system_prompt_addendum="The user is in confirmation mode.",
        compound_graph=CompoundMissionPlan(
            compound_transaction_id="ct_1",
            legs=[
                CompoundMissionLeg(
                    leg_id="leg_1",
                    agent_id="lumo-flight",
                    agent_display_name="Lumo Flight",
                    description="Book outbound flight",
                    depends_on=[],
                ),
                CompoundMissionLeg(
                    leg_id="leg_2",
                    agent_id="lumo-hotel",
                    agent_display_name="Lumo Hotel",
                    description="Book hotel after flight lands",
                    depends_on=["leg_1"],
                ),
            ],
        ),
        profile_summary_hints=ProfileSummaryHints(
            available_fields=["name", "email"],
            required_missing_fields=["dob"],
            prefill_summary="Name + email available; DOB missing",
        ),
    )
    json_str = full.model_dump_json()
    rehydrated = PlanResponse.model_validate_json(json_str)
    assert rehydrated == full


# ────────────────────────────────────────────────────────────────────
# Endpoint smoke
# ────────────────────────────────────────────────────────────────────


def test_plan_endpoint_returns_classified_response() -> None:
    res = client.post(
        "/api/tools/plan",
        json={
            "user_message": "hi",
            "session_id": "sess_1",
            "user_id": "anon",
        },
        headers=_auth_headers(),
    )
    assert res.status_code == 200
    # Phase 1: stub header reports "0" (intent_bucket is real, the
    # rest of the response is still placeholder). The header lets
    # codex's parallel-write distinguish without parsing the body.
    assert res.headers.get(STUB_HEADER_NAME) == STUB_HEADER_VALUE
    body = res.json()
    assert body["intent_bucket"] in {"fast_path", "tool_path", "reasoning_path"}
    assert body["planning_step"] == "clarification"
    assert body["suggestions"] == []
    # Phase 1 fills system_prompt_addendum with the classifier's
    # reasoning string for parallel-write debug visibility.
    assert isinstance(body["system_prompt_addendum"], str)
    assert body["system_prompt_addendum"]
    assert body["compound_graph"] is None
    assert body["profile_summary_hints"] is None
    # Telemetry headers populated for similarity-based decisions —
    # 'hi' goes through the embedding path, not the flight guard.
    assert res.headers.get(CONFIDENCE_HEADER_NAME) is not None
    assert 0.0 <= float(res.headers[CONFIDENCE_HEADER_NAME]) <= 1.0
    assert res.headers.get(TOP_SCORE_HEADER_NAME) is not None
    assert res.headers.get(GAP_HEADER_NAME) is not None


def test_plan_endpoint_omits_score_headers_on_guard_path() -> None:
    """Flight-search guard short-circuits before embedding, so
    top_score / gap are NULL — codex's agent_plan_compare row should
    capture that absence rather than synthetic values."""
    res = client.post(
        "/api/tools/plan",
        json={
            "user_message": "book me a flight to Vegas",
            "session_id": "sess_guard",
            "user_id": "anon",
        },
        headers=_auth_headers(),
    )
    assert res.status_code == 200
    body = res.json()
    assert body["intent_bucket"] == "tool_path"
    # Confidence is still set (the guard reports 1.0); but the score
    # signals are absent because they don't apply.
    assert res.headers.get(CONFIDENCE_HEADER_NAME) is not None
    assert TOP_SCORE_HEADER_NAME not in res.headers
    assert GAP_HEADER_NAME not in res.headers


def test_plan_endpoint_rejects_missing_jwt() -> None:
    res = client.post(
        "/api/tools/plan",
        json={"user_message": "hi", "session_id": "s", "user_id": "anon"},
    )
    assert res.status_code == 401
    assert res.json()["detail"]["error"] == "missing_bearer"


def test_plan_endpoint_rejects_malformed_body() -> None:
    res = client.post(
        "/api/tools/plan",
        json={"user_message": "hi"},  # missing session_id + user_id
        headers=_auth_headers(),
    )
    assert res.status_code == 422


def test_plan_endpoint_in_openapi() -> None:
    res = client.get("/openapi.json")
    assert res.status_code == 200
    paths = res.json()["paths"]
    assert "/api/tools/plan" in paths
    plan_op = paths["/api/tools/plan"]["post"]
    assert plan_op["operationId"] == "lumo_plan"
    assert plan_op.get("x-lumo-tool") is True


# ────────────────────────────────────────────────────────────────────
# Field-bound regressions — protect the wire contract
# ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "field, value",
    [
        ("user_message", ""),
        ("session_id", ""),
        ("user_id", ""),
        ("user_message", "x" * 4001),
    ],
)
def test_plan_request_rejects_out_of_bounds(field: str, value: str) -> None:
    payload = {"user_message": "hi", "session_id": "s", "user_id": "u"}
    payload[field] = value
    with pytest.raises(ValueError):
        PlanRequest.model_validate(payload)


def test_plan_response_caps_suggestions_at_four() -> None:
    too_many = [Suggestion(id=f"s{i}", label=f"L{i}", value=f"v{i}") for i in range(5)]
    with pytest.raises(ValueError):
        PlanResponse(
            intent_bucket="fast_path",
            planning_step="clarification",
            suggestions=too_many,
        )


def test_chat_turn_rejects_unknown_role() -> None:
    with pytest.raises(ValueError):
        ChatTurn.model_validate({"role": "system", "content": "x"})
