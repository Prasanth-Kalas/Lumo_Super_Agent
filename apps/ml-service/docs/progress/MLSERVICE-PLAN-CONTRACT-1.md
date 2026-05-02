# MLSERVICE-PLAN-CONTRACT-1 — progress notes

Phase 0 contract for `POST /api/tools/plan`. Schemas + stub route +
codegen + live verification.

## Phase 0 closeout (2026-05-02)

This lane closes **Phase 0** of the Python brain track. The three
foundation lanes have all landed on `main`:

| Lane | Closed | Outcome |
|---|---|---|
| PYTHON-MONOREPO-CONSOLIDATE-1 | 2026-05-02 | `Lumo_ML_Service` content moved into `apps/ml-service/`; `packages/lumo-shared-types/` Pydantic→TS codegen pipeline live; Python CI workflow gating ruff + mypy + pytest + drift. |
| MLSERVICE-MODAL-DEPLOY-1 | 2026-05-02 | Brain reachable at `https://prasanth-kalas--lumo-ml-service-asgi.modal.run`; JWT secret in Modal Secret + Vercel envs (Production + Preview); production redeploy aliased to `lumo-super-agent.vercel.app`. |
| MLSERVICE-PLAN-CONTRACT-1 | 2026-05-02 | `POST /api/tools/plan` stub live with `X-Lumo-Plan-Stub: 1` signal; cross-language type contract codegenerated; 8 new TS interfaces consumable from `@lumo/shared-types`. |

**Phase 1 readiness:**

- The brain has a stable wire contract for the orchestrator's pre-LLM
  hop. Phase 1's `INTENT-CLASSIFIER-MIGRATE-PYTHON-1` swaps the route
  body for a real classifier without touching the wire shape.
- The codegen drift check defends the contract — any future schema
  change here without a paired regen blocks the build.
- `keep_warm` / `min_containers=1` keeps a container alive on Modal
  free tier; warm-call latency is ~830 ms p50 today (deferred to
  `MODAL-LATENCY-OPTIMIZE-1`; orchestrator already tolerates 700 ms
  forecast call timeouts so Phase 1 can ship without this resolved).
- The TS-side parallel-write client (`PLAN-CLIENT-TS-PARALLEL-WRITE-1`)
  is the matching codex lane and fires after their
  `COMPOUND-RPC-CYCLE-GUARD-1` closes; once it lands, the orchestrator
  starts shadow-writing `/plan` requests and Phase 1's real classifier
  has a feedback loop to land into.

Claude Code Python is idle until `INTENT-CLASSIFIER-MIGRATE-PYTHON-1`
fires.

## Live verification (post-redeploy)

Modal redeploy was cached (3.4 s) — image layer unchanged, only the
`add_local_python_source("lumo_ml", "app")` mount picked up the new
files.

URL: `https://prasanth-kalas--lumo-ml-service-asgi.modal.run`

### `POST /api/tools/plan` with valid JWT

```
HTTP/2 200
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

### `POST /api/tools/plan` without JWT

```
HTTP 401
{"detail":{"error":"missing_bearer","message":"Authorization bearer is required."}}
```

### `GET /openapi.json`

`/api/tools/plan` registered with `operationId: lumo_plan`.
The `intents` list in `/.well-known/agent.json` now includes `"plan"`.

## Codegen result

`packages/lumo-shared-types/dist/index.ts` gains 8 new exported
interfaces — full names visible in the diff:

```
ChatTurn
CompoundMissionLeg
CompoundMissionPlan
PlanRequest
PlanResponse
ProfileSummaryHints
SessionAppApproval
Suggestion
```

`PlanningStep` and `IntentBucket` are inlined as literal unions on
the request/response interfaces (codegen doesn't lift them into named
type aliases — that would require manual post-processing). Codex can
extract them locally if useful.

## Test coverage

13 new tests in `tests/test_plan_endpoint.py`:

| Group | Count | What |
|---|---:|---|
| Schema round-trip | 3 | Minimal request, maximal request, full response |
| Endpoint smoke | 4 | 200 + stub header, 401 no JWT, 422 malformed body, present in OpenAPI |
| Field-bound | 6 | Empty / over-long required strings, suggestion cap of 4, ChatTurn role union |

Total pytest count after this lane: **50 passed** (37 existing + 13
new).

## Brief deviations + reasoning

* Brief asked for the route at `apps/ml-service/app/routes/plan.py`.
  Put it at `apps/ml-service/lumo_ml/plan/router.py` so the code is
  inside the `mypy lumo_ml/` gate's scope. The `app/` package is a
  thin ASGI shim outside the type-checked surface.

* `Suggestion`, `ChatTurn`, `CompoundMissionPlan`, `ProfileSummaryHints`
  use the brief's names rather than the existing TS-side names
  (`AssistantSuggestion`, `ChatMessage`,
  `AssistantCompoundDispatchFrameValue`, `BookingProfileSnapshot`).
  Each schema has a docstring noting the TS counterpart so codex's
  paired plan-client lane can alias on import. `CompoundMissionPlan`
  is a strictly narrower planning-time view — no runtime status /
  timestamp / provider_reference / evidence per leg.

* `SessionAppApproval.connection_provider` left as `string | null`
  rather than a literal union. The TS side has a
  `SessionConnectionProvider` enum but I didn't have a complete list
  of its values from the survey; tightening to a literal can land in
  a follow-up without breaking the wire shape.

## Follow-ups identified

* **PLAN-CLIENT-TS-PARALLEL-WRITE-1** (codex side) — paired lane to
  build `apps/web/lib/plan-client.ts` + parallel-write telemetry +
  migration 054. Brief says this fires after codex's current 6-lane
  queue clears.
* **INTENT-CLASSIFIER-MIGRATE-PYTHON-1** (Phase 1) — replace the stub
  body with real intent classification. Wire shape stays stable;
  drop the `X-Lumo-Plan-Stub: 1` header.
* **COMPOUND-MISSION-ROUTING-PYTHON-1** (Phase 1+) — populate
  `compound_graph` with real OR-Tools-driven planning when the
  planner detects multi-agent compound trips.
