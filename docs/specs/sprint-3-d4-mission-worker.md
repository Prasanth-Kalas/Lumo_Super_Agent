# Sprint 3 D4 — Mission Step Execution Worker

**Status:** Design draft, written during K6 coworker pass while D3 is in flight.
**Author:** Claude coworker (K6), reviewed by Kalas.
**Implements:** the next state transition after D3's `awaiting_confirmation → ready`.

---

## Goal

A background worker that picks up `mission_steps` rows in `status='ready'`,
dispatches the corresponding agent tool call, records the outcome in
`mission_execution_events`, and advances mission + step state.

D4 closes the loop between "the user said yes" (D3) and "the side effect
actually happened, audited end-to-end". After D4 ships, a mission with
no human-in-the-loop steps left should drive itself to `completed` (or
`failed`) with no operator intervention.

---

## What D2 + D3 already shipped

- **D2 (`10a49da`)** — mission persistence. Every `buildLumoMissionPlan`
  call now writes a `missions` row + N `mission_steps` rows. The state
  machine, transition validator, and reversibility taxonomy live in
  `lib/mission-execution-core.ts`. Migration `023_durable_missions.sql`
  also shipped the `next_mission_step_for_execution` RPC, which uses
  `FOR UPDATE SKIP LOCKED` for atomic claiming and already advances
  `missions.state: ready → executing` when the first step is claimed.
- **D3 (in flight)** — confirmation-card → mission-step linkage. When a
  user approves a confirmation card, the linked `mission_step`
  transitions to `status='ready'` and (if the mission was sitting in
  `awaiting_confirmation`) the mission state moves back to `executing`
  or `ready` so D4's worker can pick it up. D3 owns
  `lib/confirmation-card-mission-link.ts` and the relevant API route.

---

## What D4 adds

The execution loop. Specifically:

1. A small, idempotent worker entrypoint (server-side, no chat session
   bound) that reads ready steps via `next_mission_step_for_execution`
   and dispatches each one.
2. A session-less wrapper around the orchestrator's existing tool
   dispatcher so D4 can call the same code path the chat surface uses,
   without inventing a parallel one.
3. Event-emitting glue for `mission_execution_events` so every step
   start, success, failure, and rollup writes one row.
4. A small retry + timeout layer around individual step dispatches so
   transient failures don't immediately fail the whole mission.

D4 is **not** responsible for rollback or compensation — that's D5's
scope (see hand-off section). D4 is also **not** responsible for
issuing new confirmation cards mid-execution; if it encounters a step
that needs one, it transitions the mission to `awaiting_confirmation`
and stops.

---

## Architecture

### Trigger surface

Two viable options:

- **Option A — Vercel cron, every 1 minute.** A `/api/cron/mission-tick`
  endpoint that calls the worker for at most N seconds, then returns.
  Pros: no infra change, fits existing `ops_cron_runs` observability,
  trivial to roll back (just disable the cron). Cons: 60s minimum
  latency between user approval and side effect; not suitable for
  user-facing steps where speed matters.
- **Option B — long-running queue worker.** A separate process
  subscribed to a Postgres notify channel that the link API fires
  when a step transitions to `ready`. Pros: sub-second latency. Cons:
  new infra surface (process supervisor, separate deployment), no
  natural place to run it on Vercel.

**Recommendation:** ship Option A first. The 60s ceiling is acceptable
for Sprint 3 — the bulk of mission work today is research, content, and
booking-prep, none of which feels broken at 60s. Once observability
shows queue depth or lag is the bottleneck (using the new "Recent
missions" admin table from K6), upgrade to Option B without changing
the worker logic — only the trigger surface changes.

A practical safeguard: tighten the cron frequency from 60s → 30s → 15s
based on observed `mean(time(ready → running))`. We get four free wins
before we have to build new infrastructure.

### Dispatch path

D4 must **not** reimplement `dispatchToolCall`. The orchestrator already
has a tool dispatcher that handles agent registry lookup, tool input
validation, brain-tool routing, and `agent_tool_usage` write-back. D4
should:

1. Extract the side-effect-execution path of that dispatcher into a
   session-less helper that takes `(agent_id, tool_name, inputs,
   { mission_id, step_id, user_id })` and returns
   `{ ok, outputs, error_text, latency_ms, retryable }`.
2. The chat-bound dispatcher then becomes a thin wrapper around the
   session-less helper that adds streaming, message history, and UX.
3. D4's worker calls only the session-less helper. No chat session, no
   websocket, no streaming.

The helper should pass `mission_id` + `step_id` through to brain tools
and partner agents so server-side agents can attribute their work to a
mission for downstream audit / billing.

### Concurrency

The RPC already does `FOR UPDATE SKIP LOCKED`, so multiple workers can
run safely without claiming the same step twice. Phase 1 caps workers at
**1 per cron tick** to keep the blast radius small; Phase 2 raises to N
once we've watched real queue depth for a week. Phase 3 (if Option B
ships) runs continuously with N≥2.

Within a single tick, the worker pulls up to 10 steps and runs them in
parallel via `Promise.allSettled`. Per-tick timeout is 50s (5s safety
margin under Vercel's 60s function timeout); any step still running at
the cap is left in `running` for the next tick to detect via the
stuck-step path (see "Failure modes" below).

---

## State transitions D4 owns

D4 is the only writer for these transitions (D3 hands the baton at
`ready`, D5 takes it back at `failed` if rollback is requested):

- `mission_steps.status: ready → running` — atomic, via the RPC.
- `mission_steps.status: running → succeeded` — on dispatch success.
- `mission_steps.status: running → failed` — on dispatch failure (terminal).
- `missions.state: ready → executing` — atomic, via the RPC, when the
  first step is claimed.
- `missions.state: executing → completed` — when the last `pending` /
  `running` / `ready` step in the mission flips to `succeeded` (no
  remaining work).
- `missions.state: executing → failed` — when any step fails AND no
  remaining steps can compensate or retry. (Retry budget exhausted +
  no compensation path = failed mission.)
- `missions.state: executing → awaiting_confirmation` — if D4 pulls
  the next step and finds it requires a confirmation card that hasn't
  been issued yet. D4 issues the card via the existing
  confirmation-card pipeline (D3's surface) and parks the mission.

All transitions go through `assertMissionStateTransition` in
`lib/mission-execution-core.ts` so the validator catches any
illegal moves the worker tries to make.

---

## `mission_execution_events` D4 writes

Every state-relevant moment writes exactly one row. This is the audit
ledger D5 reads to figure out what to roll back, and what
`/admin/intelligence` will eventually surface as a per-mission timeline.

| event_type | when | payload |
| --- | --- | --- |
| `step_started` | step claimed, before dispatch | `{ tool_name, agent_id, inputs_hash }` |
| `step_succeeded` | dispatch returned ok | `{ latency_ms, outputs_hash }` |
| `step_failed` | dispatch returned !ok | `{ error_text, retryable, attempt }` |
| `step_retry_scheduled` | failed step queued for retry | `{ next_attempt_at, attempt }` |
| `mission_completed` | last step succeeded | `{ total_latency_ms, step_count }` |
| `mission_failed` | mission terminally failed | `{ failed_step_id, error_text }` |

Notes:
- We hash inputs / outputs rather than embedding them. Inputs and
  outputs already live on the `mission_steps` row; the event is a
  lightweight timeline pointer, not a copy.
- `attempt` starts at 1. Retries increment.
- All payloads are validated by a small zod schema per event type so a
  malformed write fails loudly instead of corrupting the audit trail.

---

## Failure modes + retry policy

### Per-step retries

- Default budget: **3 attempts**, exponential backoff `2s → 8s → 30s`.
- Retryable errors: network errors, 5xx upstream, `rate_limited`, brain
  service unreachable.
- Non-retryable errors (move mission to `failed` immediately): auth
  failures (401/403), tool-not-found, schema-validation failures,
  `permission_denied` from a partner agent.
- The session-less dispatcher returns `{ retryable: boolean }`. D4
  trusts that flag — it does **not** try to reclassify errors.

### Stuck running

- A step in `running` for more than **5 minutes** without any update is
  presumed stuck (the worker process likely died mid-dispatch, or a
  brain call hung past Vercel's function timeout).
- A reaper sweep runs at the top of each cron tick, finds steps with
  `status='running' AND updated_at < now() - interval '5 min'`, and
  flips them to `failed` with `retryable=true` so the next tick gets
  one more shot. The retry counter still applies — a step that gets
  stuck three times in a row is terminal.

### Per-mission failure

A mission moves to `failed` when:
- Any step exhausts its retry budget AND has no compensation, OR
- Any non-retryable error occurs on a step that has no compensation.

Compensation handling is delegated to D5; D4 just leaves the mission
in `failed` with clean state so D5 can pick up the rollback.

### Cron drift / silent failure

The worker writes an `ops_cron_runs` row each tick (existing
infrastructure), so the K5 dashboard already shows mission-tick lag.
The K6 missions table will show queue depth. Together they make D4's
health observable without inventing new dashboards.

---

## D5 hand-off (rollback)

D5 implements rollback when:
1. A mission fails partway and contains compensating steps.
2. The user explicitly requests rollback via a UI surface (e.g. an
   admin "force rollback" button or a chat message like "undo that").
3. An admin force-rolls-back a mission via the admin dashboard.

D5's algorithm walks **completed** steps in **reverse order**. For each:
- `reversibility='reversible'` — no-op. The action was read-only or
  trivially undone (e.g. cache fetches, idempotent reads).
- `reversibility='compensating'` — dispatch the step's compensating
  action. The agent declares the compensating tool + inputs in the
  manifest. **Adding the manifest field is a Sprint 3 prerequisite
  before D5 can ship** — D2's mission plan structure already has a
  `compensation` slot but no agent populates it yet.
- `reversibility='irreversible'` — skip + log. Cannot be undone; the
  user is notified via a proactive moment.

D5 is a separate Sprint 3 commit; D4 only needs to leave clean state so
D5 can read `mission_execution_events` and reconstruct the order of
operations.

---

## Open questions

1. **How does D4 know the dispatcher's signature when it doesn't have a
   chat session?** Solution: extract the side-effect-execution path
   into a session-less helper as described above. The chat dispatcher
   becomes a thin wrapper. This refactor is the first commit in the D4
   chain and should land independently so Codex can review it cleanly.
2. **What happens to a mission where the first step requires a
   confirmation card?** Today: D2's `submitMissionPlan` sets the
   mission state to `awaiting_confirmation` directly so D4 never sees
   it. Confirmed — no D4 handling needed for the trivial case. The
   tricky case is when step N (N>1) needs a card but earlier steps
   succeeded; D4 owns that transition (see state-transition table).
3. **Per-user rate limits.** A user with 10 concurrent missions could
   monopolise the worker. Phase 1: in-process round-robin by user_id
   when claiming the 10-step batch. Phase 2: a Postgres-side fairness
   policy (already noodled in the RPC's `order by` clause but not
   enforced). Will revisit when we see the first user with >3
   concurrent missions in production.
4. **Brain tools that themselves run >60s.** Some brain tools (heavy
   sandbox jobs) are async on the brain side and return a job-id.
   D4's dispatcher will need to honour that contract — return
   immediately with `status='running'` and let the brain's webhook
   close the loop. This is the only place D4 doesn't follow the
   straight-through model. Out of scope for the first D4 commit;
   tracked as a follow-on.
5. **Multi-agent permissioning.** Some steps cross agent boundaries
   (e.g. flights agent → calendar agent). Today, every cross-agent
   call goes through the orchestrator. D4's session-less dispatcher
   should preserve that; it must not bypass the orchestrator's
   permission checks just because there's no chat session.

---

## Testing

### Unit tests (in `lib/mission-execution-core.ts` test file)

- State transition validity: every transition in the table above is
  accepted; a sample of illegal transitions
  (`completed → executing`, `draft → completed`, etc.) is rejected.
- Retry counting: 3 retries, then terminal.
- Backoff schedule: produces `2s, 8s, 30s` for attempts 1, 2, 3.
- Stuck-step detection: a step in `running` for 6 minutes is flagged;
  one running for 4 minutes is not.

### Integration test (new file, e.g. `tests/mission-worker.test.mjs`)

Seed a mission with 3 ready steps that all succeed. Run one worker
tick. Assert:
- All 3 steps end in `status='succeeded'`.
- Mission ends in `state='completed'`.
- Exactly 5 rows are written to `mission_execution_events` in order:
  3 × `step_started`, interleaved with 3 × `step_succeeded`, and
  1 × `mission_completed` at the end. (Ordering is by `created_at`;
  step_started for step N comes before step_succeeded for step N.)
- The latency captured in `mission_completed` matches the wall-clock
  span of the test within reasonable bounds.

A second integration test covers the failure path: step 2 fails
non-retryably; assert mission ends in `failed`, step 3 is left in
`pending`, exactly the right events are written.

### Manual / preview test

Deploy to a Vercel preview, kick off a real mission with 3 dispatched
steps end-to-end (e.g. "summarise these 3 PDFs"). Assert:
- Mission state transitions correctly through `ready → executing →
  completed`.
- 5 events land in `mission_execution_events`.
- The `/admin/intelligence` "Recent missions" table (shipped by K6)
  reflects the transitions in near-real-time across two refreshes.

---

## D4 acceptance

D4 is shippable when:

1. A test mission with 3 dispatched steps actually executes
   end-to-end on a deployed preview environment.
2. Mission state transitions correctly through
   `ready → executing → completed` with no operator intervention.
3. Exactly the right events are written to `mission_execution_events`
   in the right order.
4. The "Recent missions" admin table (K6) shows the mission moving
   through states across cron ticks.
5. Failure-path test: a deliberately broken step lands the mission in
   `failed` with the right event row, and D5 can later rollback from
   that state.
6. No regressions in the chat surface — the session-less dispatcher
   refactor preserves all existing tool-call behaviour. The existing
   `tests/agent-tool-dispatch.test.mjs` (or equivalent) passes
   unchanged.

---

## Out of scope for D4

- Rollback / compensation logic — D5.
- New confirmation-card UI surfaces — D3 owns the surface; D4 just
  triggers it via the existing pipeline.
- Per-mission billing / cost rollups — separate Phase 3 surface.
- Real-time mission progress streaming to the chat UI — needs the
  trigger-surface upgrade from Option A to Option B first.

---

## File map (anticipated)

D4's changes will land in roughly these files. None of them collide
with D2 (`10a49da`), D3's in-flight `lib/confirmation-card-mission-link.ts`,
or K6's `lib/admin-stats*.ts` and `app/admin/intelligence/page.tsx`.

- `lib/mission-worker.ts` (new) — the worker entrypoint and tick loop.
- `lib/mission-dispatch.ts` (new) — session-less dispatcher helper, or
  a refactor of an existing dispatcher into this shape.
- `lib/mission-execution-core.ts` (extend) — retry helpers, backoff
  schedule, stuck-step predicate.
- `app/api/cron/mission-tick/route.ts` (new) — Vercel cron entrypoint
  that calls the worker, records to `ops_cron_runs`.
- `vercel.json` (extend) — register the new cron path.
- `tests/mission-worker.test.mjs` (new) — integration tests.
- `tests/mission-execution-core.test.mjs` (extend) — unit tests for
  retries / backoff / stuck-step.
- `docs/specs/lumo-intelligence-layer.md` (small ADR addendum noting
  D4 ships).
