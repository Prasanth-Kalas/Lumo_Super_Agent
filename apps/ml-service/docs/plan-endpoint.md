# `POST /api/tools/plan` — pre-LLM planning surface

The orchestrator hits this endpoint **before every assistant turn** to
get the intent bucket, suggestion chips, optional system-prompt
addendum, and (Phase 2) compound mission graph. Phase 0 ships a stub
that returns valid placeholder shapes so codex can build the parallel-
write client without waiting for the real classifier.

* Path: `POST /api/tools/plan`
* OpenAPI operation id: `lumo_plan`
* Auth: Lumo-signed JWT (same `LUMO_ML_SERVICE_JWT_SECRET` as every
  other tool route).
* Cost tier: `free` (intended to be a cheap pre-LLM hop).

## Stub-vs-real signal — `X-Lumo-Plan-Stub: 1`

The stub response includes the header:

```
X-Lumo-Plan-Stub: 1
```

Phase 1 (lane `INTENT-CLASSIFIER-MIGRATE-PYTHON-1`) will replace the
route body with real intent classification + suggestion generation
+ profile-hint extraction, and Phase 2 (lane `COMPOUND-MISSION-
ROUTING-PYTHON-1`) will add the compound graph. Across both swaps the
**wire shape stays stable**; only the `X-Lumo-Plan-Stub` header
drops.

This means codex's parallel-write client can attribute telemetry to
"stubbed" vs. "real" responses without parsing the body, and the TS
side can surface the difference in `/admin/intelligence` if useful.

## Wire shape

Pydantic schemas live at
[`lumo_ml/plan/schemas.py`](../lumo_ml/plan/schemas.py). Generated
TypeScript interfaces at
[`packages/lumo-shared-types/dist/index.ts`](../../../packages/lumo-shared-types/dist/index.ts).

### Request

```jsonc
{
  "user_message": "I want to fly to Vegas next weekend",
  "session_id": "sess_42",
  "user_id": "user_999",            // may be "anon" for unauthed turns
  "history": [
    {"role": "user",      "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "approvals": [
    {
      "user_id": "user_999",
      "session_id": "sess_42",
      "agent_id": "lumo-flight",
      "granted_scopes": ["search", "book"],
      "approved_at": "2026-05-02T00:00:00Z",
      "connected_at": "2026-05-02T00:00:01Z",
      "connection_provider": "duffel"
    }
  ],
  "planning_step_hint": "selection"   // optional; if orchestrator already knows
}
```

The JWT `sub` identifies the **orchestrator** (Lumo-signed),
not the end user. The `user_id` field in the body is the end-user
identity (which may be `"anon"` for unauthed visitors).

### Response (Phase 0 stub)

```http
HTTP/1.1 200 OK
content-type: application/json
x-lumo-plan-stub: 1

{
  "intent_bucket": "tool_path",
  "planning_step": "clarification",
  "suggestions": [],
  "system_prompt_addendum": null,
  "compound_graph": null,
  "profile_summary_hints": null
}
```

### Field semantics

| Field | Phase 0 (stub) | Phase 1+ (real) |
|---|---|---|
| `intent_bucket` | always `"tool_path"` | `"fast_path"` for cached/deterministic answers; `"tool_path"` for standard tool-use loop; `"reasoning_path"` for escalation to a larger model. |
| `planning_step` | always `"clarification"` | One of `"clarification" \| "selection" \| "confirmation" \| "post_booking"` based on conversation state. |
| `suggestions` | always `[]` | 0–4 suggestion chips, mirrors `AssistantSuggestion` in `apps/web/lib/chat-suggestions.ts`. |
| `system_prompt_addendum` | always `null` | Optional extra prompt context appended for this turn (e.g., "user is in confirmation mode — do not re-ask for traveler info"). |
| `compound_graph` | always `null` | Phase 2: planning-time `CompoundMissionPlan` when the planner detects a multi-agent compound trip. The orchestrator upgrades this into the runtime `AssistantCompoundDispatchFrameValue` once dispatch starts. |
| `profile_summary_hints` | always `null` | Slim view of available booking-profile autofill data — which fields can be autofilled, which are missing. Lets the planner shape clarification questions without parsing the full `BookingProfileSnapshot`. |

## Errors

| Status | Body | When |
|---|---|---|
| `401` | `{"detail":{"error":"missing_bearer"}}` | No `Authorization: Bearer …` header. |
| `401` | `{"detail":{"error":"invalid_bearer"}}` | JWT signature/audience/issuer/expiry mismatch. |
| `403` | `{"detail":{"error":"authenticated_user_required"}}` | JWT `sub` is empty or `"anon"` — the JWT must identify the orchestrator. |
| `422` | FastAPI default validation error body | Malformed request body (missing required field, out of bounds). |
| `503` | `{"detail":{"error":"service_auth_not_configured"}}` | `LUMO_ML_SERVICE_JWT_SECRET` not set on the brain. |

## Field-bound contract

Bounds are enforced by Pydantic and verified in
[`tests/test_plan_endpoint.py`](../tests/test_plan_endpoint.py):

| Field | Min | Max |
|---|---:|---:|
| `user_message` | 1 | 4 000 chars |
| `session_id` | 1 | 200 chars |
| `user_id` | 1 | 200 chars |
| `history` | 0 | 50 turns |
| `approvals` | 0 | 64 records |
| `suggestions` (response) | 0 | 4 |
| `compound_graph.legs` | 1 | 12 |
| `system_prompt_addendum` | – | 8 000 chars |

## Cross-language type names — codex consumption notes

The TS-side codebase already has types with similar shapes but
slightly different names. The codegen here uses the brief's names;
codex can alias on import where helpful:

```ts
// apps/web/lib/plan-client.ts (paired codex lane)
import type {
  PlanRequest,
  PlanResponse,
  Suggestion as AssistantSuggestion,        // matches existing chat-suggestions.ts
  ChatTurn,                                 // narrower than ChatMessage (no summary)
  CompoundMissionPlan,                      // planning-time; runtime is AssistantCompoundDispatchFrameValue
  ProfileSummaryHints,                      // slim view of BookingProfileSnapshot
} from "@lumo/shared-types";
```

`SessionAppApproval.connection_provider` is `string | null` here. If
codex needs a literal-union (`"duffel" | "stripe" | …`) it can be
tightened in a follow-up; the wire shape doesn't break either way.

## Curl smoke

```bash
URL=https://prasanth-kalas--lumo-ml-service-asgi.modal.run
JWT=...   # Lumo-signed, aud=lumo-ml, iss=lumo-core, sub=user_*, jti=*, scope=lumo.plan, exp>now

curl -fsS -X POST "$URL/api/tools/plan" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"user_message":"hi","session_id":"s","user_id":"anon"}' \
  -i
```

Expect HTTP 200 with `X-Lumo-Plan-Stub: 1` and the Phase 0 stub body.
