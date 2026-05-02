# ORCHESTRATOR-COMPOUND-DISPATCH-WIRE-1 Design

Status: design-only, awaiting review
Date: 2026-05-02
Branch: `codex/orchestrator-compound-dispatch-wire-1`
Prerequisite: `APPROVAL-CONNECTION-RPC-STRICT-1` merged and migration 060 applied to staging/prod

## 1. Problem

The product has the rails for compound work, but general natural-language compound
prompts do not ride those rails yet.

Current behavior for:

```text
plan a trip from chicago to vegas next entire week including hotels
```

is:

1. The app approval path may acknowledge "Approved Lumo Flights - let's go."
2. The general compound planner does not fire.
3. No `assistant_compound_dispatch` frame is emitted unless the prompt matches the
   hard-coded Vegas-weekend demo regex.
4. Ready `mission.*` steps are treated as successful no-op acknowledgements by
   `mission-executor.ts`, so even queued mission work does not become
   `duffel_search_flights`, hotel search, or restaurant search.

This lane must replace fake readiness with real sub-agent execution and compose
the user-visible answer after sub-agent outputs are available.

## 2. Non-Negotiables

- Do not start implementation until this design is reviewed.
- Do not merge this lane until approval strictness is merged and migration 060 is
  live. Otherwise approval can still fail before dispatch has a chance to run.
- Preserve single-tool flows. "Book a flight to Vegas" remains the existing
  single-agent Duffel path, not compound dispatch.
- Do not route money-moving actions directly from a planning prompt. Search and
  hold are allowed; booking still requires the existing confirmation gate.
- Keep `assistant_compound_dispatch` backwards-compatible for web and iOS.
- If a sub-agent cannot execute, surface the real failure in the final answer;
  never emit "let's go" as a substitute for work.

## 3. Recommended Architecture

Use a two-layer route:

1. **Compound detector** decides whether a turn is a compound mission.
2. **Mission executor** turns the accepted plan into real tool calls and waits
   for outputs before final composition.

Recommended detection strategy: **D. heuristic shortlist + LLM confirmation on
ambiguous cases.**

Why not a pure option:

- Pure LLM classifier adds latency and can still miss obvious keyword-rich
  prompts.
- Pure heuristic is brittle and will regress phrasing diversity.
- Python `/api/tools/plan` is useful telemetry, but TS remains authoritative
  until the cutover dial says otherwise.

## 4. Compound Detection

New module:

```text
apps/web/lib/compound/mission-detection.ts
```

Export:

```ts
export type CompoundIntentDecision =
  | {
      kind: "compound";
      confidence: number;
      reason: string;
      detected_domains: CompoundDomain[];
      requires_llm_confirmation: boolean;
    }
  | {
      kind: "single_agent" | "clarify" | "unsupported";
      confidence: number;
      reason: string;
      detected_domains: CompoundDomain[];
      requires_llm_confirmation: boolean;
    };

export type CompoundDomain =
  | "flight"
  | "hotel"
  | "restaurant"
  | "food"
  | "ground"
  | "calendar";
```

Heuristic signals:

- Travel anchor: `trip`, `travel`, `weekend`, `week`, `vacation`, `itinerary`,
  `plan`, `going to`, `in <city>`, or a city pair.
- Time anchor: explicit date, relative date, `next week`, `weekend`, duration,
  or date range.
- Multi-domain anchor: at least two of flight, hotel/lodging, dinner/restaurant,
  food, ground/cab/ride, calendar.
- Explicit compound wording: `including`, `plus`, `and hotels`, `with dinner`,
  `whole trip`, `entire week`.

Decision rules:

- High confidence compound when travel + time + at least two domains are present.
- Single-agent when exactly one transactional domain is present.
- Clarify when the user asks for a trip but has no destination or no time anchor.
- Ambiguous when travel + one extra weak signal is present. In that case, call a
  small LLM confirmation prompt that returns `compound | single_agent | clarify`
  with allowed domains.

The existing fast-path intent classifier remains intact. Compound detection runs
inside the `reasoning_path` branch or immediately before the hard-coded demo
helper so obvious compound work cannot drift into prose-only replies.

## 5. LLM Confirmation Prompt

Only use the LLM for ambiguous detector results.

Structured output:

```ts
interface CompoundIntentLLMDecision {
  decision: "compound" | "single_agent" | "clarify" | "unsupported";
  confidence: number;
  domains: CompoundDomain[];
  reason: string;
}
```

Rules:

- Allowed domains only: `flight`, `hotel`, `restaurant`, `food`, `ground`,
  `calendar`.
- `compound` requires at least two domains.
- If the prompt asks for only flights, only hotels, or only dinner, return
  `single_agent`.
- If missing destination or dates, return `clarify`.
- If unsupported providers are central to the request, return `unsupported`
  with the unsupported domain named in `reason`.

## 6. Compound DAG Construction

New module:

```text
apps/web/lib/compound/mission-planner.ts
```

Export:

```ts
export interface CompoundMissionPlan {
  mission_id?: string;
  announcement: string;
  legs: CompoundMissionLeg[];
  dependencies: CompoundMissionDependency[];
  compose_step: {
    client_step_id: "compose_reply";
    depends_on: string[];
  };
}

export interface CompoundMissionLeg {
  client_step_id: string;
  agent_id: "lumo-flights" | "lumo-hotels" | "lumo-restaurants" | "lumo-food";
  mission_tool_name:
    | "mission.flight_search"
    | "mission.hotel_search"
    | "mission.restaurant_search"
    | "mission.food_search";
  dispatch_tool_name:
    | "duffel_search_flights"
    | "hotel_search"
    | "restaurant_check_availability"
    | "food_search";
  description: string;
  line_items_hint: Record<string, unknown>;
}

export interface CompoundMissionDependency {
  dependency_step_id: string;
  dependent_step_id: string;
  edge_type:
    | "requires_arrival_time"
    | "requires_destination"
    | "requires_dates"
    | "requires_user_confirmation"
    | "custom";
}
```

Planner inputs:

- Latest user message.
- Recent conversation context.
- User region and device kind.
- Connected app state from `session_app_approvals`.
- Registry capabilities.
- Booking profile snapshot hints, but not raw PII unless a tool requires it.

Planner output constraints:

- At most 4 specialist legs.
- Agent IDs must be first-party Lumo apps only.
- Every leg must map to a known dispatch tool.
- Dependencies must form a DAG.
- `compose_reply` depends on all executable leaf steps.

Validation:

- Topologically sort the graph before persistence.
- Reject cycles before inserting or dispatching anything.
- Reject unknown `agent_id`, unknown `dispatch_tool_name`, or unsupported domain.
- Normalize before hashing: sort legs by `client_step_id`, sort dependencies by
  `(dependency_step_id, dependent_step_id, edge_type)`, then SHA-256 canonical
  JSON. This hash is a mission-run identity, not the money-moving confirmation
  digest.

## 7. Persistence Model

Use `missions` and `mission_steps` as the canonical execution ledger for this
lane.

Rationale:

- `compound_transactions` is a commercial booking unit. It is correct for the
  later confirmed booking saga, but a search/planning turn is not yet a
  transaction.
- `mission_steps` already has statuses, inputs, outputs, retries, events, and a
  cron executor.
- The prior recon showed the concrete bug: `mission.*` steps exist but are no-op
  acknowledged. Fix that path instead of inventing a parallel queue.

The `assistant_compound_dispatch` frame remains a UI projection. Its
`compound_transaction_id` field should remain for backwards compatibility, but
for mission-run dispatches the value should be a stable namespaced identifier:

```text
mission:<mission_id>
```

Client impact:

- Existing clients already render the frame itself.
- The existing `/api/compound/transactions/:id/stream` route only works for real
  compound transaction IDs. For this lane, live progress during the current chat
  turn should be emitted directly through the `/api/chat` SSE stream.
- A future `GET /api/missions/:id/stream` can replay mission progress after
  reconnect. This is a follow-up unless implementation discovers a small local
  reuse path.

## 8. Mission Executor Wiring

Replace the no-op behavior in `dispatchMissionStep` for supported mission tools.

Mapping table:

| Mission step | Dispatch tool | Provider state |
|---|---|---|
| `mission.flight_search` | `duffel_search_flights` | Real Duffel test/prod path already wired |
| `mission.hotel_search` | `hotel_search` or agent bridge equivalent | Preview/stub first; production gated on hotel agent health |
| `mission.restaurant_search` | `restaurant_check_availability` | Preview/stub first; production gated on restaurant agent health |
| `mission.food_search` | `food_search` or agent bridge equivalent | Preview/stub first |

Implementation shape:

1. Add `missionStepToDispatchTool(step)` mapping.
2. For supported mission steps, call `dispatchToolCall(dispatch_tool_name, args,
   dispatchContextForStep(step))`.
3. Persist the output into `mission_steps.outputs`.
4. Emit a `mission_step_progress` internal event and a UI-facing progress frame
   for the active chat request.
5. Leave unsupported `mission.*` tools as explicit failures, not successful
   acknowledgements.

Important: The executor should never claim success for `mission.*` unless a real
dispatch tool returned success.

## 9. Orchestrator Flow

New high-level path inside `runTurn`, before the legacy Claude tool loop:

1. Load approvals, connections, installed apps, memory, and booking profile as
   today.
2. Run compound detection on the latest user message.
3. If not compound, fall through to existing flow unchanged.
4. If compound but missing required app approvals, emit the existing install card
   for missing first-party apps. Do not execute partial work until the user has
   approved required first-party agents.
5. If compound and required agents are connected:
   - Build `CompoundMissionPlan`.
   - Validate and normalize DAG.
   - Persist a mission with N mission steps plus a compose step.
   - Emit `assistant_compound_dispatch`.
   - Execute ready steps inline for the current request using the mission
     executor dispatcher, while also allowing cron to recover stuck work later.
   - Wait for leaf outputs or bounded timeout.
   - Compose the final answer from real outputs.

Final answer composition:

- Use a short synthesis LLM call with the outputs JSON, not the original plan
  alone.
- If flight results exist, include real offer count and top option summary.
- If hotel/restaurant outputs are missing, say exactly which provider failed or
  is not configured.
- Do not invent prices, schedules, hotel names, or availability.

## 10. Streaming UX

The user should see progress before the final answer.

Recommended frames:

1. Text lead-in:

```text
I am splitting this into flight and hotel searches now.
```

2. `assistant_compound_dispatch`:

```json
{
  "kind": "assistant_compound_dispatch",
  "compound_transaction_id": "mission:<mission_id>",
  "legs": [
    {
      "leg_id": "flight_search",
      "agent_id": "lumo-flights",
      "agent_display_name": "Lumo Flights",
      "description": "Searching flights ORD -> LAS for next week",
      "status": "in_flight"
    }
  ]
}
```

3. Progress updates during the same SSE stream:

Use the existing `leg_status` frame if the web client can map it to the dispatch
strip; otherwise add a narrow additive frame:

```json
{
  "type": "assistant_compound_step_update",
  "value": {
    "kind": "assistant_compound_step_update",
    "compound_transaction_id": "mission:<mission_id>",
    "leg_id": "flight_search",
    "status": "committed",
    "output_summary": "Found 12 flight offers"
  }
}
```

Compatibility rule:

- If adding `assistant_compound_step_update`, update `events_frame_type_check`
  with a migration and keep old clients tolerant.
- If reusing `leg_status`, no migration is needed, but make sure web/iOS strips
  can update the right leg by `leg_id` and not only by ordinal.

## 11. Error Handling

Detection errors:

- Detector failure falls back to the existing single-agent path.
- LLM confirmation timeout falls back to heuristic result if high confidence;
  otherwise ask one clarifying question.

Planner validation errors:

- Cycle or invalid agent: log structured error and fall back to existing
  single-agent path with a plain apology if no safe partial work exists.
- Unknown dispatch tool: fail before persistence.

Sub-agent errors:

- Continue other independent steps when one step fails.
- Mark failed step with provider/tool error.
- Compose final answer with partial results:

```text
I found flights, but hotel search is unavailable right now. Here are the flight options I can trust.
```

Timeouts:

- Per-step timeout should be bounded by existing tool timeout discipline.
- Final composition waits for all leaf outputs or a turn-level budget.
- Timed-out steps become failed/partial, not invisible.

## 12. Tests

Detector tests:

- "plan a trip from chicago to vegas next entire week including hotels" ->
  compound with flight + hotel.
- "Going to Vegas next month, need flights + dinner reservation" -> compound
  with flight + restaurant.
- "Quick trip to Chicago" -> clarify or single-agent, depending on context.
- "Book a flight to Vegas" -> single-agent.
- "Show me food options nearby" -> single-agent.

Planner tests:

- Allowed agent IDs only.
- No more than 4 legs.
- DAG has no cycles.
- Deterministic graph hash for semantically identical normalized plans.

Executor tests:

- `mission.flight_search` calls `duffel_search_flights` through
  `dispatchToolCall`.
- Unsupported `mission.*` fails rather than returning acknowledged success.
- Partial failure composes an honest final response.

Integration tests:

- Approved Lumo Flights + prompt with hotels -> emits compound dispatch with at
  least flight + hotel.
- Flight leg calls Duffel mock and returns a flight-offers selection payload or
  a summarized trusted output.
- Existing single flight request still emits the normal `flight_offers` card and
  does not create a compound mission.

## 13. Rollout Plan

1. Ship behind `LUMO_COMPOUND_MISSION_ROUTING=true`, default off.
2. Enable on Vercel preview.
3. Run five-prompt corpus:
   - Vegas week with hotel.
   - NYC weekend with dinner.
   - Paris food tour.
   - Beach getaway with hotel and flight.
   - Ski week with lodging.
4. Verify no fake success, no no-op `mission.*` success, and real outputs in the
   final answer.
5. Flip production only after approval strictness and provider envs are healthy.

## 14. Deferred Follow-Ups

- `COMPOUND-MISSION-ROUTING-PYTHON-1` - OR-Tools optimization and Python-side
  planner once TS baseline works.
- `COMPOUND-DISPATCH-OBSERVABILITY-1` - traced spans, per-step cost, and
  correlation IDs.
- `COMPOUND-MISSION-STREAM-REPLAY-1` - durable mission stream endpoint for
  reconnects after `/api/chat` closes.
- `HOTEL-AGENT-CONNECTOR-1` - replace hotel stub/preview path with the real
  provider connector.
- `OPENTABLE-AGENT-CONNECTOR-1` - replace restaurant stub/preview path with the
  real provider connector.
- `COMPOUND-CALENDAR-CHECK-1` - add calendar conflict checks as a real mission
  node.

## 15. Section 11 Open Questions For Review

1. Should `assistant_compound_dispatch.compound_transaction_id` accept the
   `mission:<mission_id>` namespace for pre-booking search, or should we add a
   sibling `assistant_mission_dispatch` frame to avoid overloading the field?
2. For this lane's acceptance, are hotel and restaurant preview stubs acceptable
   as "real MCP tool calls" until provider keys land, provided failures are
   honest in production?
3. Should inline execution happen inside `/api/chat` for the first version, or
   should `/api/chat` only enqueue mission steps and a background worker stream
   updates later? Inline gives the demo an immediate answer; background is more
   durable but heavier.
4. Should compound detection run before app approval gates, or should it reuse
   the existing mission planner's required-agent list first and only route to
   compound once every required app is connected?
5. Do we want a new additive SSE frame `assistant_compound_step_update`, or do we
   constrain implementation to existing `leg_status` frames for migration-free
   compatibility?
