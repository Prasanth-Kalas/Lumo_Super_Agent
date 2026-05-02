"""FastAPI router for ``POST /api/tools/plan``.

Phase 1 wires the real anchor-based intent classifier
(:mod:`lumo_ml.plan.classifier`) into the route. The wire shape is
unchanged from Phase 0 — only the ``intent_bucket`` and
``system_prompt_addendum`` fields now carry meaningful data instead of
placeholders, and the ``X-Lumo-Plan-Stub`` response header reports
``0`` so codex's parallel-write telemetry can distinguish stub from
real responses without parsing the body.

Phase 1's SUGGESTIONS-MIGRATE-PYTHON-1 lane wires
:func:`lumo_ml.plan.suggestions.build_assistant_suggestions` so
``PlanResponse.suggestions`` carries Python-generated chips when the
orchestrator passes ``last_assistant_message``. ``X-Lumo-Suggestions-
Source: python`` and ``X-Lumo-Suggestions-Count: N`` headers expose
the chip-generation result to codex's parallel-write capture.

``compound_graph`` and ``profile_summary_hints`` are still ``None`` —
they ship in their own follow-up lanes (``COMPOUND-MISSION-ROUTING-
PYTHON-1`` plus a future booking-profile-hints migration).

The brief asked for this file at ``apps/ml-service/app/routes/plan.py``.
We put it here under ``lumo_ml/`` instead because ``app/`` is just a
thin ASGI shim that re-exports ``lumo_ml.main:app`` — code there isn't
covered by ``mypy apps/ml-service/lumo_ml/`` per the doctrine, so the
real route lives in the type-checked surface.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from ..auth import AuthContext, require_lumo_jwt
from .classifier import IntentClassifier
from .schemas import PlanRequest, PlanResponse
from .suggestions import build_assistant_suggestions
from .system_prompt import build_system_prompt

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

# Per-turn suggestion telemetry (SUGGESTIONS-MIGRATE-PYTHON-1).
# ``Source: python`` is constant for the duration of this lane — a
# future SUGGESTIONS-CUTOVER-1 will widen the value to ``both`` then
# ``python-only``. ``Count`` is the post-dedupe slice count (0–4),
# emitted on every classified turn including those that emit no chips
# (``Count: 0`` is meaningful — it distinguishes "ran but no chips
# qualified" from "didn't run").
SUGGESTIONS_SOURCE_HEADER_NAME = "X-Lumo-Suggestions-Source"
SUGGESTIONS_SOURCE_HEADER_VALUE = "python"
SUGGESTIONS_COUNT_HEADER_NAME = "X-Lumo-Suggestions-Count"

# Per-turn system-prompt telemetry (SYSTEM-PROMPT-MIGRATE-PYTHON-1).
# ``Source: python`` is constant for this lane; widens to ``both`` /
# ``python-only`` when SYSTEM-PROMPT-CUTOVER-1 fires. ``Length`` is
# emitted in chars (not tokens) so codex's logger can spot length
# divergence without re-running a tokenizer.
SYSTEM_PROMPT_SOURCE_HEADER_NAME = "X-Lumo-System-Prompt-Source"
SYSTEM_PROMPT_SOURCE_HEADER_VALUE = "python"
SYSTEM_PROMPT_LENGTH_HEADER_NAME = "X-Lumo-System-Prompt-Length"


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

    planning_step = req.planning_step_hint or "clarification"

    # The chip cascade scores regex against the assistant's text — pre-
    # LLM /plan calls (the canonical Phase 1 case) have no assistant
    # text yet and emit zero chips. Once the orchestrator wires post-
    # LLM /plan calls (or replays from history) the cascade runs.
    suggestions = (
        build_assistant_suggestions(
            assistant_text=req.last_assistant_message,
            planning_step=planning_step,
            latest_user_message=req.user_message,
        )
        if req.last_assistant_message
        else []
    )
    response.headers[SUGGESTIONS_SOURCE_HEADER_NAME] = SUGGESTIONS_SOURCE_HEADER_VALUE
    response.headers[SUGGESTIONS_COUNT_HEADER_NAME] = str(len(suggestions))

    # The system-prompt builder needs ``user_region`` (always present
    # via PlanRequest's "US" default) plus optional memory / ambient /
    # booking_profile / agents. Pre-LLM /plan calls without those bits
    # still produce a valid (smaller) prompt; full parity with TS only
    # arrives when codex's plan-client serializes the orchestrator
    # state into the new fields. We emit ``full_system_prompt = None``
    # only if the caller passed no ``user_region`` — but the field has
    # a "US" default so this is effectively always populated post-Phase
    # 1.
    full_system_prompt = build_system_prompt(
        agents=req.agents,
        now=datetime.now(tz=timezone.utc),
        user_region=req.user_region,
        user_first_name=req.user_first_name,
        mode=req.mode,
        memory=req.memory,
        ambient=req.ambient,
        booking_profile=req.booking_profile,
    )
    response.headers[SYSTEM_PROMPT_SOURCE_HEADER_NAME] = SYSTEM_PROMPT_SOURCE_HEADER_VALUE
    response.headers[SYSTEM_PROMPT_LENGTH_HEADER_NAME] = str(len(full_system_prompt))

    return PlanResponse(
        intent_bucket=classification.bucket,
        planning_step=planning_step,
        suggestions=suggestions,
        # Surface the classifier's reasoning as the prompt addendum —
        # codex's parallel-write logs both sides side-by-side and this
        # makes disagreement diagnosis possible without an extra debug
        # endpoint.
        system_prompt_addendum=classification.reasoning,
        full_system_prompt=full_system_prompt,
        compound_graph=None,
        profile_summary_hints=None,
    )
