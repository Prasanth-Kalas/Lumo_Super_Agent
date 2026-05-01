"""FastAPI router for ``POST /api/tools/plan``.

Phase 0 ships a stub that returns a valid ``PlanResponse`` shape with
neutral placeholder values. Phase 1 will replace the body with real
intent classification, suggestion generation, and (later) compound
mission planning. The wire shape stays stable; only the
``X-Lumo-Plan-Stub: 1`` response header drops when the real classifier
is wired.

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
from .schemas import PlanRequest, PlanResponse

router = APIRouter()

STUB_HEADER_NAME = "X-Lumo-Plan-Stub"
STUB_HEADER_VALUE = "1"


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
    return PlanResponse(
        intent_bucket="tool_path",
        planning_step="clarification",
        suggestions=[],
        system_prompt_addendum=None,
        compound_graph=None,
        profile_summary_hints=None,
    )
