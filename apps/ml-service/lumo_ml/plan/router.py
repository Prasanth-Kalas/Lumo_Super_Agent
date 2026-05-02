"""FastAPI router for ``POST /api/tools/plan``.

Phase 1 wires the real anchor-based intent classifier
(:mod:`lumo_ml.plan.classifier`) into the route. The wire shape is
unchanged from Phase 0 — only the ``intent_bucket`` and
``system_prompt_addendum`` fields now carry meaningful data instead of
placeholders, and the ``X-Lumo-Plan-Stub`` response header reports
``0`` so codex's parallel-write telemetry can distinguish stub from
real responses without parsing the body.

``suggestions``, ``compound_graph``, and ``profile_summary_hints`` are
still ``[]`` / ``None`` — they ship in their own follow-up lanes
(``SUGGESTIONS-MIGRATE-PYTHON-1``, ``COMPOUND-MISSION-ROUTING-PYTHON-1``,
plus a future booking-profile-hints migration).

The brief asked for this file at ``apps/ml-service/app/routes/plan.py``.
We put it here under ``lumo_ml/`` instead because ``app/`` is just a
thin ASGI shim that re-exports ``lumo_ml.main:app`` — code there isn't
covered by ``mypy apps/ml-service/lumo_ml/`` per the doctrine, so the
real route lives in the type-checked surface.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from ..auth import AuthContext, require_lumo_jwt
from .classifier import IntentClassifier
from .schemas import PlanRequest, PlanResponse

router = APIRouter()

STUB_HEADER_NAME = "X-Lumo-Plan-Stub"
# Phase 1 sets this to "0" — the classifier ships, the rest of the
# response (suggestions / compound_graph / profile_summary_hints) is
# still placeholder. Once those fields land their own lanes the
# header should drop entirely.
STUB_HEADER_VALUE = "0"

# First-class telemetry headers for codex's parallel-write
# ``agent_plan_compare`` capture. Top score is the mean cosine of the
# message embedding against the winning bucket's anchors; gap is the
# margin to the runner-up. Both omitted when the deterministic flight-
# search guard short-circuits — the guard is a binary signal, not a
# score-based decision, and a NULL row in agent_plan_compare records
# that distinction.
TOP_SCORE_HEADER_NAME = "X-Lumo-Plan-Top-Score"
GAP_HEADER_NAME = "X-Lumo-Plan-Gap"
CONFIDENCE_HEADER_NAME = "X-Lumo-Plan-Confidence"


def _plan_extra() -> dict:
    return {
        "x-lumo-tool": True,
        "x-lumo-cost-tier": "free",
        "x-lumo-requires-confirmation": False,
        "x-lumo-intent-tags": ["planning", "intent", "suggestions"],
    }


Auth = Annotated[AuthContext, Depends(require_lumo_jwt)]


@router.post(
    "/api/tools/plan",
    operation_id="lumo_plan",
    response_model=PlanResponse,
    openapi_extra=_plan_extra(),
)
def route_plan(req: PlanRequest, response: Response, _auth: Auth) -> PlanResponse:
    response.headers[STUB_HEADER_NAME] = STUB_HEADER_VALUE
    classification = IntentClassifier.get_instance().classify(req.user_message)
    response.headers[CONFIDENCE_HEADER_NAME] = f"{classification.confidence:.4f}"
    if classification.top_score is not None:
        response.headers[TOP_SCORE_HEADER_NAME] = f"{classification.top_score:.4f}"
    if classification.gap is not None:
        response.headers[GAP_HEADER_NAME] = f"{classification.gap:.4f}"
    return PlanResponse(
        intent_bucket=classification.bucket,
        planning_step=req.planning_step_hint or "clarification",
        suggestions=[],
        # Surface the classifier's reasoning as the prompt addendum —
        # codex's parallel-write logs both sides side-by-side and this
        # makes disagreement diagnosis possible without an extra debug
        # endpoint.
        system_prompt_addendum=classification.reasoning,
        compound_graph=None,
        profile_summary_hints=None,
    )
