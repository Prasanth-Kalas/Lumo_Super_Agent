# ORCHESTRATOR-COMPOUND-DISPATCH-INVESTIGATE-1 Recon

Date: 2026-05-02
Branch: `codex/orchestrator-compound-dispatch-investigate-1`
Scope: investigation only; no fix code in this commit.

## Executive finding

The reported flow is not dying in one place. It has two stacked blockers:

1. **First-party approval is acknowledged even when the connection write fails.** Production logs show `connect_first_party_session_app_approval` failing with `column reference "user_id" is ambiguous`, but `/api/chat` still emits `Approved Lumo Flights - let's go.` and returns before normal orchestration. That leaves the session without a connected approval, so later turns can re-enter the install/approval path instead of dispatching.
2. **General compound mission routing is not wired.** The only web producer for `assistant_compound_dispatch` is the hard-coded Vegas-weekend helper. The exact user prompt, `plan a trip from chicago to vegas next entire week including hotels`, does not match that regex. If it reaches the normal mission planner, ready mission steps are persisted as `mission.*` tools, and the cron executor currently treats `mission.*` steps as acknowledged no-ops rather than dispatching real sub-agent tools or creating a compound transaction.

This is why the user sees approval acknowledgements and no actual planning: the approval layer can claim success without a dispatchable connection, and the mission execution layer does not convert the approved multi-leg intent into `duffel_search_flights`, hotel search, or a compound graph.

## Runtime evidence

Vercel logs for production `/api/chat` requests in the live repro window show:

```text
[app-installs] upsert failed: Could not find the table 'public.user_agent_installs' in the schema cache
[session-app-approvals] first-party connect failed: column reference "user_id" is ambiguous
```

Repeated mission executor cron logs show a queue that is ready but not draining:

```text
[mission-executor] claim diagnostic {
  runtime_role: 'service_role',
  ready_steps: 24,
  ready_missions: 5,
  claimable_ready_steps: 5
}
```

Other production logs in the same window also show registry/schema drift:

```text
[registry] health probe failed for hotel: ZodError: checked_at Required
[registry] env var LUMO_OPEN_WEATHER_AGENT_URL referenced by registry config is unset
[admin-settings] read llm.model failed: Could not find the table 'public.admin_settings' in the schema cache
[runtime-policy] usage insert failed: Could not find the table 'public.agent_tool_usage' in the schema cache
```

I could not directly query the `events` table from this worktree because the local env only exposes Supabase URL/anon key names; no service-role key is available. The code path below is therefore the source-of-truth trace for whether the `assistant_compound_dispatch` frame can be emitted for the prompt.

## Control-flow trace

### 1. Typed approval short-circuits the chat route

`apps/web/app/api/chat/route.ts:206-224` calls `commitPendingInstallDecisionFromText(...)` before the normal `runTurn(...)` path. If that helper returns a decision, the route emits an internal card-state frame, emits the approval text, sends `done`, records `done`, and returns.

That means a typed approval turn cannot also continue planning or dispatch in the same request.

### 2. The helper says "Approved" after a non-throwing write path

`apps/web/lib/mission-install-natural-language.ts:87-119` calls `commitMissionInstallApproval(...)` and then unconditionally returns:

```text
Approved ${display_name} - let's go.
```

`apps/web/lib/mission-install-approval.ts:103-136` captures the install row and session approval row, but it does not require either to be non-null before reporting success.

`apps/web/lib/session-app-approvals.ts:142-154` calls the RPC and returns `null` on error:

```ts
if (error) {
  console.warn("[session-app-approvals] first-party connect failed:", error.message);
  return null;
}
```

So the production RPC error can be swallowed, while the user still sees a success acknowledgement.

### 3. The RPC itself has an ambiguous `user_id` reference

Both `db/migrations/051_session_app_approval_connections.sql` and the later replacement body in `db/migrations/053_user_app_approvals.sql` contain:

```sql
select id
  into active_connection_id
  from public.agent_connections
 where user_id = p_user_id
   and agent_id = normalized_agent_id
   and status = 'active'
```

Inside a PL/pgSQL function returning a table with `user_id`, that unqualified `user_id` is ambiguous. Production confirms the failure. The fix should qualify column names, for example `public.agent_connections.user_id = p_user_id`, and should make the TS caller fail closed if the first-party session approval cannot be connected.

### 4. Connected approvals are the dispatch gate

`apps/web/lib/orchestrator.ts:409-416` derives `sessionConnectedAgentIds` only from approvals whose `connected_at` is not null. It adds those IDs to `connectedAgentIds` and `dispatchReadyAgentIds`.

If the RPC failure leaves no connected approval, the mission planner sees the app as not ready and can re-emit permission/install UX instead of exposing or dispatching the agent.

### 5. The exact prompt cannot emit a compound dispatch frame today

`apps/web/lib/orchestrator.ts:425-435` only emits `assistant_compound_dispatch` from `maybeCreateVegasWeekendCompoundDispatch(...)`.

`apps/web/lib/compound/demo-dispatch.ts:21-23` gates that helper on:

```ts
/\bplan\b[\s\S]{0,80}\bvegas\b[\s\S]{0,80}\bweekend\b/i
```

The repro prompt says `next entire week including hotels`, not `weekend`, so this path returns null. There is no general `mission-planner.ts` or `compound_trip` planner on `main`; `COMPOUND-MISSION-ROUTING-1` is still only queued in status notes, not landed.

### 6. Ready mission steps do not dispatch real agent tools

`apps/web/lib/mission-execution-core.ts:181-204` persists mission steps as tool names like `mission.flights`, `mission.hotels`, etc.

`apps/web/lib/mission-executor.ts:175-190` explicitly treats every `mission.*` step as a successful acknowledgement:

```ts
if (step.tool_name.startsWith("mission.")) {
  return { ok: true, result: { status: "acknowledged", ... } };
}
```

So even when the mission executor claims a ready step, it is not invoking `duffel_search_flights`, not creating a compound transaction, and not emitting `assistant_compound_dispatch`. That explains the "rails exist, but messages are not riding them" symptom.

## Answers to the requested checks

### Does the orchestrator emit `assistant_compound_dispatch` for this prompt?

No, by code inspection. The only emission is the hard-coded Vegas-weekend helper, and the prompt does not match its regex. I could not query the production `events` table without a service-role key, but no general compound-dispatch path exists on `main` for this prompt.

### If yes, is there a worker/handler subscribed to it?

Not applicable for the prompt, because no frame is emitted. More importantly: `assistant_compound_dispatch` is currently an SSE/UI frame plus event-log record, not a work queue. The live worker is `/api/cron/execute-mission-steps`, and it consumes `mission_steps`, not `events.frame_type = assistant_compound_dispatch`.

### If no event emitted, is this LLM, prompt, or routing?

The primary missing piece is not the LLM prompt; it is deterministic routing/wiring. The hard-coded demo helper sits before the LLM. The general LLM-driven compound mission planner has not landed. After the demo regex misses, the request falls back to the older mission-plan/LLM/tool loop.

The fast-path classifier already treats compound plans as `reasoning_path`, not `fast_path`, so hypothesis C is low-confidence.

### Why does the LLM emit "Approved Lumo Flights - let's go"?

That text is not model-authored. It is deterministic server text from `commitPendingInstallDecisionFromText(...)`. The route emits it before calling `runTurn(...)` and then returns.

## Ranked hypotheses

1. **D + DB hardening gap: approval is the last/only thing the route does, and the approval write can fail while still returning success.** High confidence. Production logs show the RPC failure; code swallows it and still emits the approval text.
2. **A: compound-dispatch UI/event type exists, but no execution consumer is wired to that event type.** High confidence, with nuance. The event does not fire for the prompt; if it did, it would render UI and persist an audit event, not execute sub-agents.
3. **B: system prompt/model hallucination.** Medium-low confidence. The user-visible "Approved" string is deterministic, not LLM text. Later prose-only planning could still be model drift, but it happens after deterministic dispatch wiring fails to set the app ready or create a compound graph.
4. **C: intent classifier misroutes to fast path.** Low confidence. The classifier prompt explicitly sends travel booking and compound plans to `reasoning_path`, and the deterministic mission preflight runs before the LLM bridge.

## Recommended fix lane

The next fix should not start with prompt tuning. It should harden the deterministic state transitions first.

Recommended P0 lane: `APPROVAL-CONNECTION-RPC-STRICT-1`

Deliverables:

1. Migration: replace `connect_first_party_session_app_approval(...)` with fully-qualified SQL column references in both `agent_connections` lookup/update paths.
2. Route/helper hardening: make `commitMissionInstallApproval(...)` fail closed for first-party apps when `connectFirstPartySessionAppApproval(...)` returns null. Do not emit `Approved ... let's go` unless `connected_at` is present.
3. User-facing failure: if the connection RPC fails, emit a short retryable error instead of an approval state frame.
4. Tests: RPC ambiguity regression, natural-language approval no longer reports success when connection write fails, and post-approval `sessionConnectedAgentIds` contains the approved first-party agent.

Then follow immediately with: `ORCHESTRATOR-COMPOUND-DISPATCH-WIRE-1`

Deliverables:

1. Replace/extend the hard-coded `maybeCreateVegasWeekendCompoundDispatch(...)` with the scoped `COMPOUND-MISSION-ROUTING-1` planner for prompts like `plan a trip from chicago to vegas next entire week including hotels`.
2. Create a compound transaction and emit `assistant_compound_dispatch` from the validated plan.
3. Decide whether ready `mission.*` steps remain audit-only or become real tool dispatches. If they remain audit-only, stop treating them as the product execution path.
4. Add an integration test proving: approval succeeds -> connected approval exists -> compound prompt emits `assistant_compound_dispatch` -> flight leg dispatch uses `duffel_search_flights` or the compound API path, not a `mission.*` no-op.

## Operational notes

- Production logs show missing `user_agent_installs`, `admin_settings`, `agent_tool_usage`, and `agent_runtime_overrides` from the PostgREST schema cache. Either production is pointed at a Supabase project missing older migrations, or the schema cache needs reload after SQL-editor applies. This is not the only root cause, but it is making the approval/runtime layers brittle.
- Hotel registry health is failing with a health-report shape error (`checked_at` missing). Even after the compound planner lands, the hotel leg may be unavailable until the hotel agent health response matches `HealthReportSchema`.
- The current local env lacks `SUPABASE_SERVICE_ROLE_KEY`, so local reproduction can load code paths but not inspect or mutate the real event/mission ledger.
