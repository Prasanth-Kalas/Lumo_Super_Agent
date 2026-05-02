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

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from ..core import Secret

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
    # PYTHON-OBSERVABILITY-1 §11.4 — chat content is user-derived
    # and may include emails / phone numbers / payment hints. Layer-A
    # redacted in logs via the Secret marker; serialization to the
    # wire is unaffected.
    content: Annotated[str, Secret] = Field(max_length=20_000)


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


# ──────────────────────────────────────────────────────────────────────
# System-prompt builder inputs (SYSTEM-PROMPT-MIGRATE-PYTHON-1).
# These mirror TS-side shapes from apps/web/lib/{system-prompt,memory,
# booking-profile-core}.ts so codex's plan-client can serialize each
# directly. Reviewer Q11.2 answered A.2 — extend PlanRequest with these
# as optional inputs rather than have the brain reach into Supabase.
# ──────────────────────────────────────────────────────────────────────

InteractionMode = Literal["text", "voice"]
"""``text`` → card-first behaviour. ``voice`` → appends the 350-line
VOICE_MODE_PROMPT block (apps/web/lib/voice-format.ts:330)."""


class AgentManifestForPrompt(BaseModel):
    """Slim subset of ``RegistryEntry`` needed by ``buildSystemPrompt``
    — the prompt only renders display_name, agent_id, one_liner, and
    up to 3 example utterances per agent. ``health_score`` gates the
    CURRENTLY UNAVAILABLE block."""

    display_name: str = Field(min_length=1, max_length=200)
    agent_id: str = Field(min_length=1, max_length=120)
    one_liner: str = Field(min_length=1, max_length=400)
    example_utterances: list[str] = Field(default_factory=list, max_length=12)
    health_score: float = Field(default=1.0, ge=0, le=1)


class AddressPayload(BaseModel):
    """Mirrors apps/web/lib/memory.ts:AddressPayload — every field
    optional; ``addressToLine`` formatter joins ``line1, city, region,
    country`` with ``label`` prefix when present."""

    label: str | None = None
    line1: str | None = None
    line2: str | None = None
    city: str | None = None
    region: str | None = None
    country: str | None = None
    postal_code: str | None = None


FactCategory = Literal[
    "preference", "identity", "habit", "location",
    "constraint", "context", "milestone", "other",
]
FactSource = Literal["explicit", "inferred", "behavioral"]


class UserProfile(BaseModel):
    """Mirrors apps/web/lib/memory.ts:UserProfile. The 13 whitelisted
    fields surfaced by ``profileToLines`` are: display_name, timezone,
    preferred_language, home_address, work_address, dietary_flags,
    allergies, preferred_cuisines, preferred_airline_class,
    preferred_airline_seat, preferred_hotel_chains, budget_tier,
    preferred_payment_hint.

    PYTHON-OBSERVABILITY-1 §11.4 — every user-derived field is
    ``Secret``-annotated by default. The opt-out (regular ``str``)
    is ``id``, ``timezone``, ``preferred_language``, and the
    bucket-shaped lists (``dietary_flags``, ``allergies``,
    ``preferred_cuisines``, ``preferred_hotel_chains``,
    ``budget_tier``) — those are queryable telemetry dimensions, not
    PII. Names, addresses, payment hints, and seat preferences carry
    enough re-identification risk to redact by default.
    """

    id: str
    display_name: Annotated[str | None, Secret] = None
    timezone: str | None = None
    preferred_language: str | None = None
    home_address: Annotated[AddressPayload | None, Secret] = None
    work_address: Annotated[AddressPayload | None, Secret] = None
    dietary_flags: list[str] = Field(default_factory=list, max_length=32)
    allergies: list[str] = Field(default_factory=list, max_length=32)
    preferred_cuisines: list[str] = Field(default_factory=list, max_length=32)
    preferred_airline_class: str | None = None
    preferred_airline_seat: Annotated[str | None, Secret] = None
    preferred_hotel_chains: list[str] = Field(default_factory=list, max_length=32)
    budget_tier: str | None = None
    preferred_payment_hint: Annotated[str | None, Secret] = None


class UserFact(BaseModel):
    """Mirrors apps/web/lib/memory.ts:UserFact. The prompt only renders
    ``[category] fact`` per row; other fields ride along for codex's
    consumer-side selection logic.

    PYTHON-OBSERVABILITY-1 §11.4 — the ``fact`` field will eventually
    contain the most sensitive memory content (recurring travel
    addresses, medical preferences, payment-method labels). Layer-A
    redacted in logs."""

    id: str
    fact: Annotated[str, Secret] = Field(min_length=1, max_length=2000)
    category: FactCategory
    source: FactSource | None = None
    confidence: float | None = None


class BehaviorPattern(BaseModel):
    """Mirrors apps/web/lib/memory.ts:BehaviorPattern. The prompt
    renders ``description (observed N×)`` per row."""

    id: str
    description: str = Field(min_length=1, max_length=2000)
    evidence_count: int = Field(ge=0)


class MemorySnapshot(BaseModel):
    """The bag the orchestrator hands ``buildSystemPrompt`` for memory
    context. Mirrors the inline TS shape ``{profile, facts[],
    patterns[]}`` declared on ``BuildSystemPromptOpts.memory``."""

    profile: UserProfile | None = None
    facts: list[UserFact] = Field(default_factory=list, max_length=64)
    patterns: list[BehaviorPattern] = Field(default_factory=list, max_length=32)


class AmbientCoords(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0)


class AmbientContext(BaseModel):
    """Mirrors apps/web/lib/system-prompt.ts:AmbientContext — browser-
    sent right-now signals, never persisted."""

    local_time: str | None = Field(default=None, max_length=64)
    timezone: str | None = Field(default=None, max_length=64)
    coords: AmbientCoords | None = None
    location_label: str | None = Field(default=None, max_length=200)
    device_kind: str | None = Field(default=None, max_length=32)


# ── Booking profile (mirrors apps/web/lib/booking-profile-core.ts) ──


BookingProfileFieldStatus = Literal["present", "missing", "not_in_scope"]
BookingProfileFieldName = Literal[
    "name", "email", "phone", "payment_method_id",
    "traveler_profile", "passport", "passport_optional", "dob",
]


class BookingProfileFieldSlim(BaseModel):
    """Slim view of ``BookingProfileField<T>``. The prompt only reads
    ``status`` and the optional ``label`` — never the typed value — so
    the wire shape doesn't have to discriminate on the field's type
    parameter."""

    status: BookingProfileFieldStatus
    label: str | None = Field(default=None, max_length=200)


class BookingProfileSnapshot(BaseModel):
    """Mirrors apps/web/lib/booking-profile-core.ts:BookingProfileSnapshot
    — pruned to the subset the prompt actually reads. Codex's plan-
    client serializes only ``status`` + ``label`` per field; the typed
    payload values stay TS-side."""

    user_id: str = Field(min_length=1, max_length=200)
    granted_scopes: list[str] = Field(default_factory=list, max_length=64)
    fields: dict[str, BookingProfileFieldSlim] = Field(default_factory=dict)
    required_missing_fields: list[BookingProfileFieldName] = Field(
        default_factory=list, max_length=8,
    )
    prefill_summary: str | None = Field(default=None, max_length=2000)


class PlanRequest(BaseModel):
    user_message: str = Field(min_length=1, max_length=4000)
    session_id: str = Field(min_length=1, max_length=200)
    user_id: str = Field(min_length=1, max_length=200)
    """End-user identity. May be ``"anon"`` for unauthed visitors. The
    JWT subject identifies the orchestrator, not the end user."""
    history: list[ChatTurn] = Field(default_factory=list, max_length=50)
    approvals: list[SessionAppApproval] = Field(default_factory=list, max_length=64)
    planning_step_hint: PlanningStep | None = None
    # PYTHON-OBSERVABILITY-1 §11.4 — the assistant text quotes back
    # user content (greetings, addresses, dates, names) and may
    # contain memory-fact echoes. Layer-A redacted in logs.
    last_assistant_message: Annotated[str | None, Field(max_length=20_000), Secret] = None
    """The assistant's text from the prior turn (or the current turn at
    end-of-LLM call when the orchestrator wires up post-generation
    /plan calls). Required input for suggestion-chip generation —
    mirrors ``assistantText`` in
    ``apps/web/lib/chat-suggestions.ts:buildAssistantSuggestions``.
    ``None`` when no assistant text is yet available (cold-start /
    pre-LLM /plan call); the brain returns ``suggestions=[]`` in that
    case."""

    # System-prompt inputs (SYSTEM-PROMPT-MIGRATE-PYTHON-1). All
    # optional + additive: TS callers that don't send these get an
    # empty ``full_system_prompt`` in the response. Once codex's plan-
    # client lands the wire-side serialization, every classified turn
    # will carry the full set.
    # PYTHON-OBSERVABILITY-1 §11.4 — user-derived fields carry the
    # ``Secret`` marker so logs and span attributes redact them via
    # Layer A. Wire-level serialization is unaffected.
    user_first_name: Annotated[str | None, Field(max_length=120), Secret] = None
    user_region: str = Field(default="US", min_length=2, max_length=8)
    mode: InteractionMode = "text"
    agents: list[AgentManifestForPrompt] = Field(default_factory=list, max_length=80)
    memory: MemorySnapshot | None = None
    ambient: AmbientContext | None = None
    booking_profile: BookingProfileSnapshot | None = None


class PlanResponse(BaseModel):
    intent_bucket: IntentBucket
    planning_step: PlanningStep
    suggestions: list[Suggestion] = Field(default_factory=list, max_length=4)
    system_prompt_addendum: str | None = Field(default=None, max_length=8000)
    """Diagnostic / classifier-reasoning string, e.g. ``"anchor-
    similarity tool_path (top=0.245, gap=0.081)"``. Used by codex's
    parallel-write capture for classifier-disagreement diagnosis. NOT
    a system-prompt fragment — for the actual prompt, see
    ``full_system_prompt``."""
    full_system_prompt: str | None = Field(default=None, max_length=30_000)
    """Python-built canonical system prompt string mirroring TS's
    ``apps/web/lib/system-prompt.ts:buildSystemPrompt``. ``None`` when
    the request didn't carry the inputs (``agents``, ``user_region``,
    etc.) needed to build it; the orchestrator falls back to the TS
    output in that case. 30 KB cap accommodates ~2500-token text-mode
    prompt + 350-line voice-mode block + comfortable headroom."""
    compound_graph: CompoundMissionPlan | None = None
    profile_summary_hints: ProfileSummaryHints | None = None
