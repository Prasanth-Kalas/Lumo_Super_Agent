# Sprint 3 D5 — Mission Rollback

**Status:** Design draft, written during K9 coworker pass while D4 is in flight.
**Author:** Claude coworker (K9), reviewed by Kalas.
**Implements:** the rollback path triggered when a mission fails partway,
the user explicitly cancels mid-flight, or an admin force-rolls-back.

---

## Goal

When a mission's execution fails midway through (or the user explicitly
requests rollback), walk back through the steps that already succeeded
and undo them where the agent contract permits. Mark the mission as
`rolled_back` with a complete audit trail of what was reverted, what
was compensated, and what could not be undone.

D5 closes the safety loop that D2-D4 set up. D2 wrote the reversibility
labels onto every step. D3 made sure no irreversible side effect could
fire without a confirmation card. D4 ran the steps end-to-end. D5 is
the answer to the question "and what happens when something goes
wrong?" — without it, a half-executed mission leaves Lumo's audit story
honest only up to the point of failure, with no automated remediation
for the bookings, sends, and writes that already escaped.

After D5 ships, every mission has exactly one of three terminal
outcomes — `completed`, `failed` with the rollback story explicit in
`mission_execution_events`, or `rolled_back` with the same. There is
no "failed and we have no idea what's still out there" state. That is
the bar.

---

## What D2 + D3 + D4 already shipped

- **D2 (`10a49da`)** — mission persistence + state machine + reversibility
  taxonomy. `lib/mission-execution-core.ts` owns the pure transitions.
  `mission_steps.reversibility` is one of `'reversible'`,
  `'compensating'`, or `'irreversible'`. The `STATE_TRANSITIONS` table
  already permits `executing → rolled_back`,
  `awaiting_confirmation → rolled_back`, `failed → rolled_back`, and
  `awaiting_permissions → rolled_back`. The transition validator will
  enforce these for D5 with no schema changes to the validator itself
  (only the addition of an intermediate `rolling_back` state, see
  below).
- **D3 (`1475bcd`)** — confirmation card linkage. Steps that need user
  approval get linked to a card; approve/dismiss/expire transitions
  are recorded on `mission_steps.status` and a `card_resolved` event
  is written to `mission_execution_events`. D5 reads these events
  during rollback to know which side effects actually fired vs. which
  the user dismissed.
- **D4 (in flight)** — step execution worker. Claims `ready` steps via
  `next_mission_step_for_execution`, dispatches via the session-less
  helper, records `step_started/step_succeeded/step_failed/
  mission_completed/mission_failed` events. Per-step retry budget
  caps at 3. D4 leaves a failed mission in `state='failed'` with
  clean per-step status so D5 can pick up the rollback cleanly.

---

## What D5 adds

The rollback execution path. Triggered by:

1. **Auto-rollback after step failure** — when a step exhausts retries
   AND prior succeeded steps include compensating or reversible
   actions, D5 automatically attempts to reverse them. This is the
   default for any user who has not opted out via a per-mission flag
   (`plan.auto_rollback_on_failure`, default `true`).
2. **Explicit user cancel** — user clicks "Cancel mission" mid-flight
   from the workspace mission card. The currently-running step is
   allowed to finish (we do not interrupt in-flight side effects),
   then rollback walks the prior completed steps. If there is no
   currently-running step (mission is in `awaiting_confirmation` or
   `awaiting_user_input`), rollback starts immediately.
3. **Admin force-rollback** — from the `/admin/intelligence` page, an
   admin clicks "Roll back" on a mission row. Force-rollback bypasses
   the auto-rollback flag and works on missions in any non-terminal
   state, including `completed` (for the rare "we shipped, but…" case
   — though `irreversible` steps in a `completed` mission will simply
   log + skip; admin cannot undo a flight booking by clicking a
   button).

D5 is **not** responsible for re-planning a mission after rollback
("and now do it differently"). Re-plans are a Sprint 4 surface — D5
just gets the world back to a known state and writes the audit story.

---

## Reversibility semantics (recap from D2)

Defined in `lib/mission-execution-core.ts:18`:

- **`reversible`** — the action was read-only or trivially undone.
  Examples: fetching availability, computing a route, summarising a
  document, pulling weather, vector recall, search-style steps. D5
  no-ops on these; the rollback log just notes
  `rollback_step_skipped` with `reason: 'reversible_noop'`.
- **`compensating`** — the action created a side effect that can be
  undone with a counter-action. Examples: cancel a held booking,
  revoke a scheduled post, refund a charge that has not settled,
  delete a draft message we sent to ourselves, undo a calendar event
  we created. D5 dispatches the compensating action via the agent
  contract.
- **`irreversible`** — the action cannot be undone. Examples: a sent
  message that the recipient has already read, a tax form filed, a
  public timeline post that has been engaged with, a payment that
  has settled, an account creation. D5 cannot reverse it; the
  rollback log notes `rollback_step_skipped` with
  `reason: 'irreversible'` and the user is notified via a proactive
  moment ("we couldn't undo step 3 — here's what's still out there").

The taxonomy is intentionally conservative. When `inferReversibility`
in D2 cannot decide, it falls back to `reversible` only for clearly
read-only steps and `irreversible` for booking/payment shapes — the
default-to-irreversible posture means D5 will always err on the side
of "log + warn the user" rather than "silently fail an attempted
undo."

---

## Agent contract additions D5 requires

For `compensating` steps to be reversible at execution time, agents
must declare a compensating action in their manifest. D2 left a
`compensation` slot in the mission plan structure but no agent
populates it yet — the SDK addition lands as the first commit of D5
so the contract is in place before rollback dispatch is wired.

```typescript
interface AgentToolManifest {
  name: string;
  // ... existing fields (inputs schema, outputs schema, etc.)
  reversibility?: "reversible" | "compensating" | "irreversible";
  compensating_tool?: string;          // tool name to call to undo
                                        // this action; must exist on
                                        // the same agent
  compensating_inputs_template?: object; // jsonb template; fields like
                                          //  {{outputs.booking_id}}
                                          //  get substituted from the
                                          //  original step's outputs
                                          //  at rollback time
  compensating_window_seconds?: number;  // optional: how long after
                                          //  the original step a
                                          //  compensating call is
                                          //  still valid (e.g. 24h
                                          //  for a settled refund);
                                          //  past the window D5
                                          //  treats as irreversible
}
```

Validation rules (enforced by the agent registry on manifest
publish, not at rollback time):

- If `reversibility: "compensating"` is declared but
  `compensating_tool` is missing or refers to an unknown tool on the
  agent, the manifest is rejected at publish time. This guarantees
  D5 never has to handle a "broken compensation" runtime case from a
  freshly-published manifest.
- For agents that were live before this contract addition, the
  registry imputes `irreversible` until they republish. This is
  conservative-by-default: a partner who has not yet declared
  compensation cannot accidentally have D5 attempt a wrong undo.
- `compensating_inputs_template` is rendered with the same template
  substitution helper used by the orchestrator's tool-input
  rendering — no new template engine is introduced.

---

## State transitions D5 owns

D5 introduces a new intermediate mission state `rolling_back` so the
user and admin both see the rollback in progress, instead of a
confusing "the mission is in `failed` but events are still being
written" gap. The state is added to D2's `MissionState` union and
to the `STATE_TRANSITIONS` table in
`lib/mission-execution-core.ts`. Migration 025 adds the same value
to the database CHECK constraint.

| From state | Trigger | To state | Actor |
| --- | --- | --- | --- |
| `executing` | step terminally failed AND auto-rollback enabled | `rolling_back` | D5 worker (auto) |
| `executing` | user clicks Cancel | `rolling_back` | API route (user) |
| `awaiting_confirmation` | user clicks Cancel | `rolling_back` | API route (user) |
| `awaiting_user_input` | user clicks Cancel | `rolling_back` | API route (user) |
| `awaiting_permissions` | user clicks Cancel | `rolled_back` (no steps to undo) | API route (user) |
| any non-terminal | admin force-rollback | `rolling_back` | admin route (admin) |
| `failed` | admin force-rollback | `rolling_back` | admin route (admin) |
| `rolling_back` | all prior steps walked, no rollback errors | `rolled_back` | D5 worker |
| `rolling_back` | one or more compensations failed past retry budget | `rolled_back` (with `partial=true` flag in rollback_completed event) | D5 worker |

The `rolling_back` state is non-terminal. Crucially, the
`STATE_TRANSITIONS` map for `rolling_back` is `["rolled_back"]` only
— a rollback cannot be cancelled, retried, or re-routed mid-flight.
This is by design: a partial rollback that gets re-cancelled and then
re-resumed is too easy to reason about wrong.

The transition validator must be updated. Specifically these new
allowed edges:

- `executing → rolling_back`
- `awaiting_confirmation → rolling_back`
- `awaiting_user_input → rolling_back`
- `awaiting_permissions → rolled_back`
- `failed → rolling_back`
- `completed → rolling_back` (admin only — see safeguards below)
- `rolling_back → rolled_back`

Both `assertMissionStateTransition` and any RLS / DB-level CHECK that
gates state moves must reflect these. The unit-test suite in the
existing `lib/mission-execution-core.ts` test file is extended.

---

## How D5 dispatches compensating actions

The core algorithm:

1. Mission enters `rolling_back` (via any of the triggers above).
   A `rollback_initiated` event is written with the trigger source
   and the reason (`step_failed`, `user_cancel`, `admin_force`).
2. D5 worker reads `mission_steps` for the mission, ordered by
   `step_order DESC`, filtered to `status='succeeded'` (we only undo
   what actually fired) plus `status='running'` for the
   currently-running step that has been allowed to finish (its
   final status is settled by D4 before D5 reads).
3. For each candidate step in reverse order:
   - **If `reversibility='reversible'`** — write
     `rollback_step_skipped` with `reason: 'reversible_noop'`,
     update step status to `rolled_back`, move on.
   - **If `reversibility='compensating'` and a valid
     `compensating_tool` exists** —
     1. Render `compensating_inputs_template` against the original
        step's `outputs` jsonb.
     2. Write `rollback_step_started`.
     3. Dispatch via the same session-less helper D4 uses
        (`mission-dispatch.ts` from D4), targeting
        `agent.compensating_tool`. This guarantees D5 inherits
        D4's permission checks, retry layer, and
        `agent_tool_usage` accounting.
     4. On success: write `rollback_step_succeeded`, set the
        original step's status to `rolled_back`.
     5. On failure: retry per the retry policy below.
   - **If `reversibility='irreversible'`** — write
     `rollback_step_skipped` with `reason: 'irreversible'`, leave
     the original step status as `succeeded` (we did not undo it,
     so it is not honest to mark it `rolled_back`), proceed to the
     next prior step.
   - **If `reversibility='compensating'` but the agent has been
     uninstalled or the tool can't be resolved** — write
     `rollback_step_skipped` with `reason: 'no_compensating_tool'`
     or `'agent_uninstalled'`, leave step `succeeded`.
4. After the last prior step is walked, write `rollback_completed`
   with the rollup counts and transition the mission to
   `rolled_back`.

D5 must **not** invent its own dispatcher. The session-less helper
from D4 handles agent registry lookup, tool input validation, brain
routing, and `agent_tool_usage` write-back. D5's contribution is a
thin layer that:

- Knows how to render `compensating_inputs_template` against the
  original step's outputs.
- Tags every rollback dispatch with
  `{ mission_id, step_id, rollback: true }` so the helper writes
  `agent_tool_usage` rows with `purpose='rollback'` for billing /
  audit attribution.
- Maps the helper's `{ ok, outputs, error_text, retryable }` back
  to the rollback-event vocabulary.

---

## `mission_execution_events` D5 writes

| event_type | when | payload |
| --- | --- | --- |
| `rollback_initiated` | mission enters `rolling_back` | `{ trigger: 'auto' \| 'user' \| 'admin', reason: 'step_failed' \| 'user_cancel' \| 'admin_force', actor_user_id?, failed_step_id? }` |
| `rollback_step_started` | compensating dispatch begins | `{ step_id, original_tool, compensating_tool, attempt }` |
| `rollback_step_succeeded` | compensating dispatch ok | `{ step_id, latency_ms, compensating_outputs_hash }` |
| `rollback_step_failed` | compensating dispatch !ok | `{ step_id, error_text, retryable, attempt }` |
| `rollback_step_retry_scheduled` | failed compensation queued for retry | `{ step_id, next_attempt_at, attempt }` |
| `rollback_step_skipped` | step not eligible for compensation | `{ step_id, reason: 'reversible_noop' \| 'irreversible' \| 'no_compensating_tool' \| 'agent_uninstalled' \| 'window_expired' }` |
| `rollback_completed` | mission reaches `rolled_back` | `{ steps_rolled_back, steps_skipped, steps_failed_to_rollback, partial: boolean }` |

Notes:

- Following D4's pattern, inputs and outputs are hashed in the event
  payloads. The full rendered compensating inputs and the
  compensation outputs live on a new `mission_step_rollback_attempts`
  table (see "Schema additions" below) so we have one row per
  attempt and the audit trail is queryable without parsing event
  payloads.
- `partial=true` in `rollback_completed` means at least one
  compensating step failed past its retry budget OR was skipped due
  to `irreversible`. This flag drives the user-visible "some
  actions could not be reversed" copy and the admin badge.
- All payloads are validated by zod schemas, again following D4.

---

## Failure modes + retry policy

### Compensating tool fails

- Retry budget: **3 attempts**, exponential backoff `2s → 8s → 30s`.
  Identical to D4 so the retry layer can be shared.
- Retryable errors: network errors, 5xx upstream, `rate_limited`,
  brain service unreachable. The session-less dispatcher returns
  `{ retryable: boolean }` and D5 trusts it.
- Non-retryable errors (mark `rollback_step_failed` immediately):
  auth failures (401/403), tool-not-found, schema-validation
  failures, `permission_denied`, `not_found` (the original side
  effect already vanished — e.g. the booking was independently
  cancelled by the partner before our compensation reached it).

### Compensating tool times out (>30s per attempt)

- Treated as failure with `retryable=true` for the first two
  attempts, then non-retryable. The 30s cap matches D4's per-step
  timeout — keeping rollback dispatch on the same wall-clock budget
  as forward dispatch makes the per-tick budgeting trivial.

### Compensating tool not found / agent unhealthy

- Skip step, log `rollback_step_skipped` with reason
  `'no_compensating_tool'` or `'agent_uninstalled'`, proceed to next
  prior step. The mission still completes its rollback walk; only
  this step is marked partial.

### Compensation window expired

- If the manifest declares
  `compensating_window_seconds` and `now() - step.finished_at`
  exceeds it, skip with `'window_expired'`. The original step stays
  `succeeded`. Use case: a refund window that has closed.

### Mission already in `rolled_back` when admin clicks force

- No-op, return current state to the admin route. Idempotency at
  the API surface so a double-click does not re-walk.

### Rollback worker crashes mid-walk

- Idempotency rules below catch this — on restart, the worker reads
  events, detects which steps already have a terminal rollback
  event, and resumes from the next prior step.

### "Step that has not finished yet"

- D5 never starts walking until the currently-running step (if any)
  has settled. The user-cancel API route writes a
  `rollback_initiated` event with the trigger but the worker tick
  defers the actual walk until D4 has finished its in-flight
  dispatch. This is enforced by checking
  `mission_steps WHERE status='running'` is empty before the worker
  proceeds past the initiated marker.

---

## Idempotency

D5 must be idempotent in case the worker crashes mid-rollback. Each
rollback step records `rollback_step_started` before dispatch and
`rollback_step_succeeded`/`failed`/`skipped` after.

On restart, the worker reads `mission_execution_events` for the
mission, builds a per-step "last terminal rollback event" map, and:

- If a step already has `rollback_step_succeeded` or
  `rollback_step_skipped` → skip, move to next prior.
- If a step has `rollback_step_started` but no terminal yet → treat
  as "in flight at crash time," check the
  `mission_step_rollback_attempts` row for that attempt; if no
  outputs were recorded, retry the dispatch (same attempt number);
  if outputs were recorded but the terminal event was never
  written, write the terminal event now (the dispatch succeeded,
  we just lost the chance to log it before the crash) and move on.
- If a step has `rollback_step_failed` and attempts < 3 → next tick
  picks it up via the retry schedule.
- If a step has `rollback_step_failed` and attempts === 3 → mark
  step status `rollback_failed` (new step status, see "Schema
  additions"), proceed to next prior, set the mission's eventual
  rollup to `partial=true`.

Rule of thumb: every rollback step has at most one row per attempt
in `mission_step_rollback_attempts` and exactly one terminal event
per step (`succeeded`, `failed-after-3-attempts`, or `skipped`)
once the mission reaches `rolled_back`.

---

## Schema additions (Migration 025)

A single migration covers all D5 schema work so it can land
atomically:

1. Add `'rolling_back'` to the `missions.state` CHECK constraint
   alongside the existing values.
2. Add `'rollback_failed'` to the `mission_steps.status` CHECK
   constraint. This is distinct from the existing
   `'rolled_back'` (success) and `'failed'` (forward dispatch
   failed) — `'rollback_failed'` means "we tried to reverse this
   succeeded step three times and could not." It surfaces clearly
   in the admin table.
3. New table `public.mission_step_rollback_attempts`:
   ```sql
   create table public.mission_step_rollback_attempts (
     id           bigint generated by default as identity primary key,
     mission_id   uuid not null references public.missions(id) on delete cascade,
     step_id      uuid not null references public.mission_steps(id) on delete cascade,
     attempt      smallint not null check (attempt between 1 and 3),
     compensating_tool text not null,
     rendered_inputs jsonb not null default '{}'::jsonb,
     outputs      jsonb,
     status       text not null check (status in ('running','succeeded','failed','timed_out')),
     started_at   timestamptz not null default now(),
     finished_at  timestamptz,
     error_text   text,
     unique (step_id, attempt)
   );
   ```
   Service-role only, RLS enabled, mirrors `mission_steps` security
   posture.
4. New RPC `next_rollback_step_for_execution(requested_limit int)`:
   the rollback equivalent of D4's claiming RPC. Atomically picks
   the next-prior step in any `state='rolling_back'` mission whose
   prior-step rollback walk has reached it, with
   `FOR UPDATE SKIP LOCKED`. Service-role only, follows the exact
   pattern of `next_mission_step_for_execution`.
5. Add `mission_steps_by_rollback_status` partial index on
   `(mission_id, step_order desc) where status in ('succeeded','running','rollback_failed')`
   to speed up the reverse-walk reads.
6. Optional: a `missions_rolling_back_for_execution` partial index
   parallel to `missions_ready_for_execution` for fast cron pickup.

---

## User-visible surfaces

### Workspace mission card (`/workspace`)

- Mission cards in `executing`, `awaiting_confirmation`, or
  `awaiting_user_input` get a "Cancel mission" button. Clicking it
  POSTs to `/api/missions/[id]/cancel`, which writes a
  `rollback_initiated` event with `trigger='user'` and transitions
  the mission to `rolling_back`. The card immediately shows
  `Rolling back...` with a step-by-step progress indicator pulled
  from `mission_execution_events`.
- When the mission reaches `rolled_back`, the card shows a summary:
  "X steps reversed, Y skipped (read-only), Z couldn't be undone."
  The Z section is expandable and lists the original tool calls
  with the irreversibility reason.
- A new mission state badge color is needed: `rolling_back` =
  amber, `rolled_back` = grey-with-strike.

### Admin dashboard (`/admin/intelligence`)

- The Recent Missions table from K6 already shows mission state.
  D5 extends the row to include a "Force rollback" action button
  visible only on missions in non-terminal states or `failed`.
  Clicking opens a small modal: "Roll back mission for user X?
  This will attempt to reverse N succeeded steps. Reason
  (optional): ___". On submit, POST to
  `/api/admin/missions/[id]/rollback` with the reason as the event
  payload's `actor_reason`.
- A new column `Rollback summary` shows
  `5 / 5 reversed`, `4 / 5 reversed (1 partial)`, etc. for missions
  in `rolling_back` and `rolled_back`.
- A small "Partial rollback" badge appears on
  `rolled_back` missions where any step failed compensation or was
  irreversible.

### Chat surface

- Out of scope for D5's first cut. D5 writes events; whether the
  chat surface exposes "I just rolled back your booking" is a
  Sprint 4 conversational surface decision. The data is there for
  whoever lands that work.

---

## D5 implementation sketch (for Codex)

Files D5 will create (none collide with D4's anticipated file map
in `docs/specs/sprint-3-d4-mission-worker.md`, K6's admin surface,
or D3's confirmation-card-mission-link layer):

- `app/api/cron/rollback-missions/route.ts` (new) — cron route,
  every 1 minute, parallel to D4's executor cron. Claims
  rollback steps via `next_rollback_step_for_execution`, runs them,
  records to `ops_cron_runs`. Phase 1 cap: 1 worker per tick, up
  to 10 steps in parallel via `Promise.allSettled`.
- `app/api/missions/[id]/cancel/route.ts` (new) — user-facing
  cancel endpoint. POST. Validates the mission belongs to the
  authenticated user. Writes `rollback_initiated` with
  `trigger='user'`. Idempotent: a second call on a mission already
  in `rolling_back` or `rolled_back` returns the current state
  without writing a second event.
- `app/api/admin/missions/[id]/rollback/route.ts` (new) —
  admin-gated force-rollback endpoint. POST. Validates admin role
  (uses the same admin gate as `/admin/intelligence`). Writes
  `rollback_initiated` with `trigger='admin'` and the
  `actor_user_id` of the admin. Body accepts an optional
  `actor_reason` string.
- `lib/mission-rollback-core.ts` (new) — pure helpers, no DB
  access. Owns:
  - `selectRollbackTargets(steps): RollbackPlan` — given the
    mission's step rows, returns the ordered list of compensating
    actions to run, with their inputs templates pre-paired.
  - `renderCompensatingInputs(template, outputs): rendered` — the
    template substitution helper, reusing the orchestrator's
    existing engine.
  - `classifyCompensationError(err): { retryable, terminal_reason }`
    — central place for the error taxonomy.
  - `nextRollbackState(steps): MissionState` — predicate for
    "are we ready to mark the mission `rolled_back` yet?"
- `lib/mission-rollback.ts` (new) — DB writes + dispatcher hand-off,
  parallel to D4's `lib/mission-worker.ts`. Owns the actual tick
  loop, the `mission_step_rollback_attempts` row writes, and the
  call into D4's session-less dispatcher.
- `lib/mission-execution-core.ts` (extend) — add `'rolling_back'`
  to `MissionState` and `STATE_TRANSITIONS`; add
  `'rollback_failed'` to `MissionStepStatus`; add a
  `rollbackTransitionValid(from, to)` helper if not already
  covered by the existing transition validator.
- `db/migrations/025_mission_rollback.sql` (new) — schema
  additions described above.
- `vercel.json` (extend) — register `/api/cron/rollback-missions`.
  This is the **only** shared file with D4's anticipated changes;
  D4 owners should know D5 will append a single cron entry. No
  conflict expected — the file is small and append-only — but
  worth flagging in the PR descriptions.
- `tests/mission-rollback-core.test.mjs` (new) — unit tests for
  the pure helpers.
- `tests/mission-rollback.test.mjs` (new) — integration test
  described below.
- `docs/specs/lumo-intelligence-layer.md` (small ADR addendum
  noting D5 ships, parallel to D4's note). **Do not write this
  during K9** — that file is shared infrastructure and the addendum
  is part of D5's eventual implementation PR, not the design doc.

---

## Open questions

1. **How does D5 know the original step's outputs are still valid
   for template substitution?** Answer: outputs are stored on
   `mission_steps.outputs` (jsonb) by D4 at step success time and
   are immutable thereafter. As long as D5 reads from
   `mission_steps` (not from a separate cache), the outputs are the
   ones that fired. If `outputs` is empty at rollback time
   (shouldn't happen for `succeeded` steps but defensible), skip
   with `'no_compensation_inputs'` and treat as partial.
2. **What if the agent itself has been uninstalled by the user
   since the mission ran?** Answer: skip with reason
   `'agent_uninstalled'`, leave step `succeeded`, surface to the
   user in the rollback summary as "this action used Agent X which
   is no longer connected — reconnect to undo, or contact
   support." Do not auto-reinstall.
3. **What if the agent is still installed but the
   `compensating_tool` has been removed from a newer manifest
   version?** Answer: dispatcher returns `tool_not_found`,
   classified as terminal non-retryable, log
   `'no_compensating_tool'`, leave step `succeeded`. The agent
   registry should warn the partner at manifest publish time when a
   `compensating_tool` referenced by historical missions is being
   removed, but enforcing that is a separate marketplace concern.
4. **How do we handle a payment that was authorised but not
   captured?** Answer: agents declare different reversibility for
   different states by exposing two separate tools — e.g.
   `authorize_payment` (compensating, with
   `compensating_tool: 'void_authorization'`) and
   `capture_payment` (irreversible). The mission plan picks the
   right one at planning time. D5 just executes whatever is
   declared.
5. **What's the user-cancel SLA on a step that's been running for
   45 seconds?** Answer: D4 has a 50s per-tick wall clock; the
   in-flight step finishes (or hits its own timeout) on the next
   tick. D5's `rollback_initiated` event is written immediately on
   user cancel, but the actual rollback walk is deferred until
   `mission_steps WHERE status='running'` is empty for that
   mission. Worst case the user sees `Rolling back...` for ~60s
   before any compensation actually fires. Acceptable for Sprint
   3; revisit if the cancel UX feels broken.
6. **Should `failed → rolling_back` be allowed automatically?**
   Answer: only if the mission's plan has
   `auto_rollback_on_failure: true` (default). For missions where
   the user explicitly opted out (e.g. "I want to keep the parts
   that succeeded"), D5 leaves the mission in `failed` and
   requires either user-cancel or admin-force to enter rollback.
   Phase 1 ships with the default `true` only; the opt-out flag is
   a Sprint 4 surface.

---

## Testing strategy

### Unit tests (`tests/mission-rollback-core.test.mjs`, new)

- `selectRollbackTargets`: given a mission with steps in
  `[reversible-succeeded, compensating-succeeded,
  irreversible-succeeded, compensating-skipped]`, returns
  `[step3, step2, step1]` (reverse-order, skipped steps excluded
  because they never fired).
- `renderCompensatingInputs`: substitutes `{{outputs.booking_id}}`
  from a step's outputs jsonb into the template.
- `classifyCompensationError`: round-trips for each known error
  shape.
- `nextRollbackState`: returns `rolled_back` only when every
  prior `succeeded` step has a terminal rollback marker.

### Unit tests (extend `tests/mission-execution-core.test.mjs`)

- All new state transitions are accepted.
- All previously-illegal transitions are still rejected (e.g.
  `completed → executing`, `rolled_back → anywhere`).
- The `rolling_back → executing` transition is rejected (can't
  resume a rollback as forward execution).

### Integration test (`tests/mission-rollback.test.mjs`, new)

Seed a mission with three succeeded steps:
- Step 0: `reversible` (e.g. `discovery.search_hotels`).
- Step 1: `compensating` (e.g. `messages.send_dm`, with a
  declared `compensating_tool: 'messages.delete_dm'`).
- Step 2: `compensating` (e.g.
  `bookings.hold_reservation`, with
  `compensating_tool: 'bookings.cancel_hold'`).

Trigger admin force-rollback. Assert:
- Mission moves through `failed → rolling_back → rolled_back`.
- Six events fire in order: `rollback_initiated`,
  `rollback_step_started` (step 2),
  `rollback_step_succeeded` (step 2),
  `rollback_step_started` (step 1),
  `rollback_step_succeeded` (step 1),
  `rollback_step_skipped` (step 0, reason `'reversible_noop'`),
  `rollback_completed` with
  `{ steps_rolled_back: 2, steps_skipped: 1, partial: false }`.
- Each compensating step has exactly one row in
  `mission_step_rollback_attempts` with `attempt=1` and
  `status='succeeded'`.
- Step 0's `mission_steps.status` is `rolled_back` (we logged it
  as a no-op), Step 1's and Step 2's are `rolled_back`.

A second integration test covers the failure path:
- Step 1's compensating tool fails three times (mocked).
- Assert: `rollback_step_failed` events 1, 2, 3 fire with
  exponential backoff, the step ends as `rollback_failed`, the
  mission still reaches `rolled_back`, and `rollback_completed`
  has `partial: true` with
  `steps_failed_to_rollback: 1`.

A third integration test covers the irreversible-skip path:
- Step 2 is `irreversible`. Trigger force-rollback. Assert
  `rollback_step_skipped` with reason `'irreversible'`, step
  remains `succeeded`, `rollback_completed` has
  `partial: true` with `steps_skipped: 1` (irreversible skips
  count toward partial).

### Manual smoke test

Deploy to a Vercel preview. Run the Vegas trip demo to a partial
state (e.g. one held booking + one sent itinerary message), then:
1. Click Cancel on the mission card.
2. Watch `/admin/intelligence` show
   `rolling_back → rolled_back` across two refreshes.
3. Open the mission detail and assert the rollback summary card
   shows the right counts and the "couldn't undo" expandable
   section is empty (since both example steps are
   compensating-with-tool).
4. Repeat the same demo but with one step being a public-post
   (irreversible). Assert the partial-rollback badge appears in
   admin and the mission card user-side shows the
   "1 action couldn't be undone" banner with the original
   tool name.

---

## D5 acceptance

D5 is shippable when:

1. A test mission with three succeeded steps (one reversible, one
   compensating, one irreversible) executes rollback end-to-end on
   a deployed preview environment.
2. The mission state transitions through
   `executing → rolling_back → rolled_back` with exactly the
   expected events: `rollback_initiated`, three
   `rollback_step_*` (one started+succeeded for the
   compensating, one skipped for reversible, one skipped for
   irreversible), and `rollback_completed`.
3. The admin dashboard shows the rolled-back mission with the
   partial-rollback badge and the right counts.
4. User-cancel from the workspace mission card produces an
   identical rollback walk for a mission seeded into
   `awaiting_confirmation` state.
5. Failure-path test: a deliberately broken compensating tool
   ends the mission in `rolled_back` with
   `partial: true` and the step in `rollback_failed`. The admin
   dashboard surfaces the partial state. No silent data loss.
6. Idempotency test: kill the rollback worker mid-walk, restart,
   assert the rollback resumes correctly without double-dispatch
   of any compensating action.
7. No regressions in D2/D3/D4. The existing test suites pass
   unchanged. The session-less dispatcher (D4's contribution) is
   shared, not forked.

---

## Out of scope for D5

- **Re-planning a rolled-back mission.** "Roll back, then try
  again with a different agent" is a Sprint 4 conversational
  surface and depends on D5 being clean.
- **Cross-mission compensation.** If Mission A reserved a hotel
  and Mission B booked a flight expecting that hotel, rolling
  back A does not auto-cancel B. Users see this as two
  independent missions; cross-mission dependency tracking is
  Phase 4 work tied to the preference graph.
- **Compensation for actions that triggered downstream effects in
  third-party systems we don't control.** A sent message that
  the recipient already read, a public post that has been shared,
  a payment whose downstream PSP has already cleared — these are
  honestly irreversible from Lumo's vantage point, and D5 logs +
  notifies rather than pretending to undo.
- **Partial-rollback resumes.** A mission that lands in
  `rolled_back` with `partial: true` is terminal. Re-attempting
  the failed compensations is a manual operations workflow,
  guided by the events table.
- **Financial reconciliation beyond what compensating tools
  provide.** If a partner's `void_authorization` succeeds but
  funds are still pending at the issuing bank for several days,
  Lumo's audit trail shows the void as succeeded; the
  bank-side settlement reconciliation is a finance-ops concern.
- **Compensating actions that themselves require user
  confirmation.** Today, compensating tools are dispatched
  silently. If a partner declares a compensating tool that
  itself surfaces a confirmation card (e.g. "are you sure you
  want to cancel?"), D5 treats that as a manifest bug and the
  registry should reject it. Allowing user-in-the-loop
  rollbacks is a future enhancement once we have a worked use
  case.

---

## File map (anticipated)

D5's changes will land in roughly these files. None of them collide
with D2 (`10a49da`), D3's `lib/confirmation-card-mission-link.ts`,
D4's anticipated `lib/mission-worker.ts` /
`lib/mission-dispatch.ts` / `app/api/cron/mission-tick/route.ts`,
or K6's `lib/admin-stats*.ts` and `app/admin/intelligence/page.tsx`.

- `lib/mission-rollback.ts` (new) — DB writes + dispatcher hand-off.
- `lib/mission-rollback-core.ts` (new) — pure helpers.
- `lib/mission-execution-core.ts` (extend) — new states/statuses.
- `app/api/cron/rollback-missions/route.ts` (new) — cron entrypoint.
- `app/api/missions/[id]/cancel/route.ts` (new) — user cancel.
- `app/api/admin/missions/[id]/rollback/route.ts` (new) — admin force.
- `db/migrations/025_mission_rollback.sql` (new) — schema additions.
- `vercel.json` (extend, append-only) — register the new cron path.
- `tests/mission-rollback-core.test.mjs` (new) — unit tests.
- `tests/mission-rollback.test.mjs` (new) — integration tests.
- `tests/mission-execution-core.test.mjs` (extend) — new transitions.
- `app/workspace/...` (small edit) — Cancel button on the mission card.
- `app/admin/intelligence/page.tsx` (coordinate with K6 owner) —
  Force rollback button + partial-rollback badge column. **Treat
  this as a coordinated edit — coordinate the merge with K6's
  in-flight admin work.**
- `docs/specs/lumo-intelligence-layer.md` (small ADR addendum
  noting D5 ships — appended in the implementation PR, **not**
  in the K9 design-doc PR).
