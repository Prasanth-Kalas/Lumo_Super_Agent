"""Pydantic schemas for ``POST /api/tools/plan``.

Source of truth for the cross-language contract. Codegen at
``packages/lumo-shared-types/codegen.py`` walks these models (via the
re-exports in ``lumo_ml/schemas.py``) and emits TypeScript interfaces
into ``packages/lumo-shared-types/dist/index.ts``. CI's drift check
fails any PR that changes the shapes here without regenerating
``dist/index.ts``.

Naming notes (for the paired codex lane that will build
``apps/web/lib/plan-client.ts``):

- ``Suggestion`` mirrors ``AssistantSuggestion`` in
  ``apps/web/lib/chat-suggestions.ts``. Same fields; codex can
  ``import { Suggestion as AssistantSuggestion }`` from
  ``@lumo/shared-types`` if they want to keep the existing TS name.
- ``ChatTurn`` is a slim subset of ``ChatMessage`` in
  ``apps/web/lib/orchestrator.ts`` — ``{role, content}`` only. The
  ``summary`` field on ChatMessage is a TS-side cache and isn't part
  of the wire contract here.
- ``CompoundMissionPlan`` is the planning-time shape (no runtime
  status / timestamp / provider_reference / evidence on each leg).
  The runtime equivalent is ``AssistantCompoundDispatchFrameValue`` in
  ``apps/web/lib/compound/dispatch-frame.ts`` — the orchestrator
  upgrades this plan into that frame once dispatch starts.
- ``ProfileSummaryHints`` is the planner's slim view of
  ``BookingProfileSnapshot`` (``apps/web/lib/booking-profile-core.ts``).
  The full snapshot stays TS-side; the planner only needs to know
  which fields can/can't autofill to shape clarification questions.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

PlanningStep = Literal["clarification", "selection", "confirmation", "post_booking"]
"""Stages of the orchestrator's planning loop. Mirrors the union in
``apps/web/lib/chat-suggestions.ts``."""

IntentBucket = Literal["fast_path", "tool_path", "reasoning_path"]
"""Top-level routing decision the planner emits per turn:

- ``fast_path`` — small / cached / deterministic answer (no LLM tool loop).
- ``tool_path`` — standard tool-use loop with a fast model.
- ``reasoning_path`` — escalation to a larger reasoning model.
"""


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20_000)


class SessionAppApproval(BaseModel):
    """Pre-bootstrapped per-session approval record. Mirrors
    ``apps/web/lib/session-app-approvals.ts``."""

    user_id: str = Field(min_length=1, max_length=200)
    session_id: str = Field(min_length=1, max_length=200)
    agent_id: str = Field(min_length=1, max_length=120)
    granted_scopes: list[str] = Field(default_factory=list, max_length=64)
    approved_at: str = Field(min_length=1, max_length=64)
    connected_at: str | None = Field(default=None, max_length=64)
    connection_provider: str | None = Field(default=None, max_length=80)


class Suggestion(BaseModel):
    """Suggestion-chip shape attached to clarification turns."""

    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=200)
    value: str = Field(min_length=1, max_length=2000)


class CompoundMissionLeg(BaseModel):
    """Planning-time leg of a compound mission."""

    leg_id: str = Field(min_length=1, max_length=80)
    agent_id: str = Field(min_length=1, max_length=120)
    agent_display_name: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=2000)
    depends_on: list[str] = Field(default_factory=list, max_length=12)


class CompoundMissionPlan(BaseModel):
    """Topologically-orderable plan emitted when the planner detects a
    multi-agent compound trip. The orchestrator uses this to seed the
    runtime ``AssistantCompoundDispatchFrameValue`` once dispatch starts.
    """

    compound_transaction_id: str = Field(min_length=1, max_length=80)
    legs: list[CompoundMissionLeg] = Field(min_length=1, max_length=12)


class ProfileSummaryHints(BaseModel):
    """Slim view of the user's booking-profile autofill state. Lets the
    planner shape clarification questions ("we have your passport but
    not DOB — ask for DOB?") without parsing the full snapshot."""

    available_fields: list[str] = Field(default_factory=list, max_length=32)
    required_missing_fields: list[str] = Field(default_factory=list, max_length=32)
    prefill_summary: str | None = Field(default=None, max_length=1000)


class PlanRequest(BaseModel):
    user_message: str = Field(min_length=1, max_length=4000)
    session_id: str = Field(min_length=1, max_length=200)
    user_id: str = Field(min_length=1, max_length=200)
    """End-user identity. May be ``"anon"`` for unauthed visitors. The
    JWT subject identifies the orchestrator, not the end user."""
    history: list[ChatTurn] = Field(default_factory=list, max_length=50)
    approvals: list[SessionAppApproval] = Field(default_factory=list, max_length=64)
    planning_step_hint: PlanningStep | None = None
    last_assistant_message: str | None = Field(default=None, max_length=20_000)
    """The assistant's text from the prior turn (or the current turn at
    end-of-LLM call when the orchestrator wires up post-generation
    /plan calls). Required input for suggestion-chip generation —
    mirrors ``assistantText`` in
    ``apps/web/lib/chat-suggestions.ts:buildAssistantSuggestions``.
    ``None`` when no assistant text is yet available (cold-start /
    pre-LLM /plan call); the brain returns ``suggestions=[]`` in that
    case."""


class PlanResponse(BaseModel):
    intent_bucket: IntentBucket
    planning_step: PlanningStep
    suggestions: list[Suggestion] = Field(default_factory=list, max_length=4)
    system_prompt_addendum: str | None = Field(default=None, max_length=8000)
    compound_graph: CompoundMissionPlan | None = None
    profile_summary_hints: ProfileSummaryHints | None = None
