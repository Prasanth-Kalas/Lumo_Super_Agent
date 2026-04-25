# ADR/PRD - Lumo Intelligence Layer

**Status:** Draft v1.0 - accepted architecture, pending implementation
**Owner:** Kalas (CEO/CTO/CFO/PM hat)
**Decision date locked:** 2026-04-26
**Related systems:** `lib/agent-registry.ts`, `lib/orchestrator.ts`, `config/agents.registry*.json`, `app/api/workspace/inbox/route.ts`, `db/migrations/005_memory.sql`, `db/migrations/012_workspace_creator.sql`

---

## 1. Decision

Lumo will ship a Python-backed Intelligence Layer as a first-party, privileged
system agent named `Lumo_ML_Service`.

This service is not a private `/api/internal/ml/*` surface. It uses the same
agent contract as every other Lumo app:

- `GET /.well-known/agent.json`
- `GET /openapi.json`
- `GET /api/health`
- tool routes declared in OpenAPI

The service is auto-installed by Lumo Core through registry policy and marked
`system: true` in Lumo-owned registry configuration. It is not privileged because
its manifest says so; it is privileged because the Lumo registry says so.

That distinction is non-negotiable. Third-party manifests must never be able to
self-declare `system: true`, bypass user install state, bypass confirmations, or
gain access to Lumo service credentials.

## 2. Product framing

The board-level framing is:

> Lumo is the OS. Agents are apps. The marketplace and permission model are the
> platform. Python is the runtime layer. Claude is the reasoning engine.

The Intelligence Layer makes the app-store thesis visible. Instead of only
calling already-installed agents, Lumo can understand intent, inspect the
marketplace, recommend missing apps, score permission risk, remember past user
data, and run safe computations.

The Phase 1 demo is the Vegas trip:

> "I am going to Vegas next Saturday for a week and returning to California.
> Book flights, hotels, cabs, food, events, attractions, and EV charging if I
> drive."

Lumo should return a structured mission plan that shows installed agents,
missing marketplace agents, permissions needed, risk flags, questions to ask,
confirmation points, and rollback/cancellation paths.

If this demo does not run end to end, Phase 1 is not done.

## 3. Accepted architecture

```text
Lumo Super Agent Core (Next.js)
  - Marketplace + registry
  - App install state + OAuth connections
  - Permission, confirmation, audit, and runtime policy
  - Voice + chat + workspace UI
  - Claude reasoning loop
        |
        | agent contract + Lumo-signed service JWT
        v
Privileged System Agent: Lumo_ML_Service (Python/FastAPI)
  - Runtime A: Cloud Run for low-latency RPC
  - Runtime B: Modal for GPU/batch jobs
  - Runtime C: E2B/Firecracker sandbox for scoped code execution
  - Storage: Supabase Postgres + pgvector
```

### Runtime decisions

| Runtime | Purpose | Why |
|---|---|---|
| Cloud Run | Hot-path tools: embed, classify, recall, rank, plan, risk score | Python wheels, scale-to-zero, container control, better fit than Vercel functions for ML dependencies |
| Modal | GPU or long-running batch: Whisper, CLIP, fine-tunes, transcript jobs | Pay per heavy job instead of keeping GPU infrastructure warm |
| E2B/Firecracker sandbox | `run_python_sandbox` and scoped file analysis | Isolated compute with ephemeral FS, CPU/memory/time limits, and controllable network egress |
| Supabase pgvector | Embeddings and recall index | Already in the platform; no new vector vendor in Phase 1 |

Cost target for Phase 1 is under $80/month at low scale. This is a budget guard,
not a signed vendor quote. Provider pricing and quotas must be revalidated before
production launch.

## 4. System-agent contract

`Lumo_ML_Service` exposes a normal agent manifest and OpenAPI document, but Lumo
Core treats it specially through registry metadata.

### Registry ownership

Add a first-class, Lumo-owned registry field:

```json
{
  "key": "lumo-ml",
  "enabled": true,
  "system": true,
  "base_url": "http://localhost:3010",
  "version": "^0.1.0"
}
```

Rules:

1. `system` is read only from `config/agents.registry*.json` or another
   Lumo-owned registry store.
2. `system` is never read from partner manifests, marketplace submissions, or
   partner-agent database rows.
3. `userScopedBridge()` includes healthy system agents for authenticated users
   even when the user has no explicit app install row.
4. System tools still obey runtime policy, confirmation cards, scope checks, and
   audit logging.
5. System status should be visible in admin/operations UI, but not removable by
   regular users.
6. System agents and user-installable OAuth agents are mutually exclusive in
   Phase 1. If an agent ever needs both behaviors, dispatch must explicitly
   prefer the user's OAuth connection for user-scoped write tools and reserve
   service JWTs for system-only tools.

### Manifest shape

The manifest should use normal SDK fields and no special privilege claims:

```json
{
  "agent_id": "lumo_ml",
  "name": "Lumo Intelligence Layer",
  "version": "0.1.0",
  "description": "First-party planning, recall, ranking, risk scoring, and sandboxed computation for Lumo.",
  "openapi_url": "/openapi.json",
  "health_url": "/api/health",
  "connect": {
    "model": "none"
  },
  "pii_scope": ["profile", "email", "calendar", "location", "workspace_content"],
  "scopes": [
    "lumo.recall.read",
    "lumo.agent.rank",
    "lumo.agent.risk.evaluate",
    "lumo.sandbox.run",
    "lumo.classify"
  ]
}
```

`connect.model: "none"` means no third-party OAuth is needed. It does not mean
public unauthenticated access. Every tool call must require a Lumo-signed service
JWT plus per-user context.

## 5. Phase 1 tools

| Tool | Input | Output | Hot path? | Notes |
|---|---|---|---|---|
| `plan_task` | user intent, installed agents, marketplace agents, user context summary | mission plan with required agents, missing agents, questions, confirmation points, rollback plan | yes | Core Vegas demo artifact |
| `rank_agents` | user intent, registry catalog, install state | ranked installed and marketplace agents with scores and reasons | yes | Drives app-store install suggestions |
| `evaluate_agent_risk` | manifest, OpenAPI summary, scopes, category peers | risk grade, over-ask flags, reasons, suggested mitigations | yes | Powers marketplace trust badges |
| `embed` | text chunks, source metadata | embedding ids, model metadata, content hashes | yes | Used by indexer and recall |
| `classify` | text/items, classifier name, thresholds | labels, calibrated scores, reasons | yes | Replaces inbox regex lead scoring |
| `recall` | query, user id, filters, top_k | cited snippets from embedded archive/transcripts/memory | yes | Target under 500ms |
| `analyze_file` | file reference, task, schema | extracted facts, tables, summary, validation issues | no | Uses sandbox or batch path depending on file size |
| `generate_chart` | tabular data or query result, chart intent | chart spec/artifact metadata | no | Computation only; UI renders in Lumo Core |
| `run_python_sandbox` | code or notebook plan, files, resource policy | stdout, stderr, artifacts, resource usage | no | E2B/Firecracker only; no side effects |

Tool outputs must use the same Lumo tool envelope conventions as partner agents:
structured JSON, stable error codes, and `_lumo_summary` where the orchestrator
needs user-readable summaries.

## 6. Data and storage

### Existing state

Lumo already has:

- `user_facts` with `vector(1536)` embeddings in `db/migrations/005_memory.sql`
- `connector_responses_archive` in `db/migrations/012_workspace_creator.sql`
- `audit_log_writes` in `db/migrations/012_workspace_creator.sql`

### New Phase 1 table

Add a separate embedding table for archived connector content:

```sql
create table if not exists public.content_embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_table text not null,
  source_row_id bigint not null,
  source_etag text not null,
  chunk_index integer not null,
  source_agent_id text,
  content_hash text not null,
  text text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(384) not null,
  model text not null,
  created_at timestamptz not null default now(),
  unique (source_table, source_row_id, source_etag, chunk_index)
);
```

Phase 1 default embedding model: `sentence-transformers/all-MiniLM-L6-v2`
(`384` dimensions) hosted in `Lumo_ML_Service`.

Keep this table separate from `user_facts` because existing memory uses
`1536`-dimensional OpenAI embeddings. If we later standardize on one model, we
can backfill with a versioned migration instead of breaking existing memory
queries.

### Indexer

The indexer lives in Lumo Core as `/api/cron/index-archive`, not inside
`Lumo_ML_Service`. Core already owns `connector_responses_archive`, cron auth,
privacy policy, and ops observability; the brain stays a stateless `embed`
tool. The cron walks `connector_responses_archive`, redacts PII at source,
chunks useful text fields, computes `source_row_id + source_etag` dedupe keys,
calls `embed` with capped concurrency, and upserts `content_embeddings`.

Operational guardrails:

- `LUMO_ARCHIVE_INDEXER_ENABLED=true` must be set before scheduled runs do work.
- `LUMO_ARCHIVE_INDEXER_ROW_LIMIT` caps archive rows per run.
- `LUMO_ARCHIVE_INDEXER_BATCH_SIZE` caps chunks per `/embed` call; default 32.
- `LUMO_ARCHIVE_INDEXER_CONCURRENCY` caps concurrent `/embed` batches; default 8.
- 429/503/504 responses from the brain are retried with short backoff.
- `content_embedding_sources` records `embedded`, `no_text`, and retryable
  `failed` states so unchanged rows are not re-embedded every run.

Initial sources:

- YouTube comments and metadata
- Email/message snippets once connector archives exist
- Calendar event text where user consent allows
- Uploaded or transcribed files in later phases

## 7. Super Agent integration work

### Registry and bridge

Implement:

1. Add `system?: boolean` to the registry config type.
2. Add a registry schema file or remove the stale `$schema` pointer. The dev
   registry currently references `./agents.registry.schema.json`, but that file
   is absent.
3. Persist `system` on `RegistryEntry`.
4. Update `userScopedBridge()` so healthy system agents are eligible for
   authenticated users without requiring app install or OAuth connection.
5. Ensure partner-agent rows cannot set or override `system`.
6. Add `lumo-ml` entries to dev/prod/Vercel registry files with environment
   overlays for Cloud Run.

### Tool dispatch

Lumo Core signs a short-lived service JWT for calls to `Lumo_ML_Service`.

JWT claims:

- `iss`: Lumo Core
- `aud`: `lumo_ml`
- `sub`: user id
- `jti`: request id
- `scope`: exact tool scope
- `exp`: short TTL, target 60 seconds

The JWT must not contain raw OAuth tokens, API keys, or full connector payloads.
The service receives only the minimal user context or source ids needed for the
tool.

### Chat/orchestrator

The orchestrator should use these tools as follows:

- Call `rank_agents` before telling a user an agent is missing.
- Call `evaluate_agent_risk` when showing marketplace install prompts or
  permission requests.
- Call `plan_task` for multi-agent missions like travel, creator workflows,
  errands, events, or home operations.
- Call `recall` when the user asks "where did I say", "who mentioned", "what
  was that", or otherwise references prior connector data.

### Workspace inbox

`app/api/workspace/inbox/route.ts` now starts every item with the local heuristic
and upgrades the score through `Lumo_ML_Service` `/api/tools/classify` when the
brain answers inside the 300ms hot-path budget. The route records each classifier
attempt through `agent_tool_usage` with `agent_id=lumo-ml` and
`tool_name=lumo_classify`.

The fallback remains the existing heuristic if the ML service is unconfigured,
unavailable, malformed, or misses the 300ms budget. Classifier payloads are
redacted through the same Core helper used by the archive indexer before they
cross into the brain service; if an inbox window exceeds the 100-item classify
cap, tail items keep the heuristic score and the route logs the cap.

The labelled Day-4 seed set lives in
`Lumo_ML_Service/tests/test_classify.py`: 100 hand-curated synthetic examples
stratified across sponsorship, consulting, speaker/podcast invites, hiring,
licensing, spam, and ordinary viewer chatter. The current seed-set eval is
classifier precision 1.00 / recall 1.00 / F1 1.00 vs. previous regex F1 0.148
at the shared lead threshold. This number is a seed/regression result, not a
held-out generalisation claim, and must not be used in external or board
communications until replaced by a randomly sampled held-out eval with a
separate validation-calibrated threshold.

## 8. Safety rules

The Intelligence Layer is powerful, but it is never allowed to bypass Lumo's
permission layer.

Non-negotiable rules:

1. No raw secrets are injected into Python, Modal jobs, or sandbox sessions.
2. Python sandbox network egress is off by default.
3. If network is needed, egress is allow-listed per task and logged.
4. Sandbox filesystem is ephemeral and scoped per invocation.
5. CPU, memory, wall-clock time, file count, and artifact size have hard limits.
6. Default sandbox timeout is 30 seconds.
7. Every sandbox invocation writes an audit event with user id, request id,
   policy, hash of code, file hashes, runtime, and result status.
8. The sandbox cannot perform booking, payment, messaging-send, posting,
   deleting, token refresh, account creation, or other account side effects.
9. Side effects happen only through existing agent tools and confirmation cards.
10. Logs redact PII, secrets, bearer tokens, and connector payload bodies.
11. Users must have deletion/export paths for embeddings and transcripts.
12. Admin/operator UI must show failures, latency, spend, and policy denials.

`system: true` means "available to the orchestrator by default." It does not
mean "trusted to do anything without confirmation."

## 9. Latency and fallbacks

Hot-path budget:

- `rank_agents`: p95 under 300ms
- `evaluate_agent_risk`: p95 under 300ms
- `classify`: p95 under 300ms
- `recall`: p95 under 500ms
- `plan_task`: p95 target under 800ms for simple plans; complex mission planning
  may stream or run as a background step

Fallback rules:

- If `classify` misses budget, use current heuristic scoring.
- If `rank_agents` misses budget, use deterministic category and keyword match.
- If `evaluate_agent_risk` misses budget, show conservative "review required"
  copy instead of a green badge.
- If `recall` misses budget, return a partial result with a "still indexing" or
  "search delayed" status.

No workspace card should block page rendering on a slow ML call.

## 10. Evals and acceptance

Phase 1 is accepted only when all of these pass:

1. Vegas demo end to end:
   - Detects travel intent from one sentence.
   - Identifies installed flight, hotel, food, maps, events, attractions, and EV
     agents where present.
   - Recommends missing marketplace agents with reasons.
   - Lists permissions and risk flags.
   - Asks user questions needed to continue.
   - Shows confirmation points before purchases, bookings, messages, or account
     creation.
2. Recall demo:
   - Answers at least five seeded "where did I/someone say X" queries from
     archived connector rows with citations.
3. Marketplace risk demo:
   - Scores at least ten sample agents and flags at least two deliberate
     over-permissioned manifests.
4. Lead classifier:
   - Beats the existing regex heuristic on a labelled 100-example set.
   - Ships with confusion matrix, threshold, and fallback documented.
5. Sandbox demo:
   - Runs a harmless computation and emits stdout/artifact metadata.
   - Denies network by default.
   - Times out a long-running script.
   - Writes audit events.
6. CI:
   - `Lumo_ML_Service` has unit tests for tools and auth.
   - Lumo Core has registry/system-agent tests.
   - Contract tests validate manifest/OpenAPI/health.

## 11. Seven-day prove-it cut

| Day | Output |
|---|---|
| 1-2 | Scaffold `Lumo_ML_Service` repo with FastAPI, Dockerfile, health route, manifest route, OpenAPI route, service JWT validation, and local dev port `3010` |
| 1-2 | Add `lumo-ml` to Lumo registry config as `system: true` and make the bridge include it for authenticated users |
| 3 | Add pgvector migration for `content_embeddings`; build indexer cron over `connector_responses_archive` |
| 4 | Train first lead classifier on 100 hand-labelled examples; wire `/api/workspace/inbox` to `classify` with heuristic fallback |
| 5 | Add E2B/Firecracker-backed `run_python_sandbox` with 30s timeout, no-network default, scoped FS, and audit logging |
| 6 | Wire `recall` and `rank_agents` into chat; run and record the Vegas demo |
| 7 | Add eval harness to CI, finish handoff docs, and update this ADR with implementation deltas |

## 12. Later phases

### Phase 2 - Marketplace brain

- Personalized marketplace ranking
- Risk badges on marketplace tiles
- Permission over-ask comparison by category
- Install prompts that explain why an agent is needed for a user task

### Phase 3 - Mission planner and cortex

- Full mission artifact from `plan_task`
- Required agents, missing permissions, questions, confirmations, rollback
- Whisper-on-Modal transcript pipeline
- Audio recall across meetings and uploads
- Best-time-to-post forecasting

### Phase 4 - Personal model

- Preference graph from approved memory and completed actions
- Optional nightly LoRA/fine-tune jobs for drafting style
- Client-side wake word path for "Hey Lumo"
- More proactive suggestions, still gated by confirmation cards

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Privilege escalation through manifest fields | `system` is registry-owned only; partner rows ignored |
| Remote code execution | E2B/Firecracker sandbox, no secrets, no-network default, hard resource limits |
| Slow workspace UI | 300ms p95 hot-path budget, rule-based fallbacks, no blocking card render |
| Embedding privacy | User-scoped rows, deletion/export paths, redacted logs, no raw connector payload logging |
| Vendor lock-in | Plain FastAPI service, portable Docker image, pgvector storage, provider-specific adapters isolated |
| Cost creep | Per-user quotas, sandbox quotas, Modal job budgets, admin spend reporting |
| Model drift | Versioned models, eval harness, threshold history, fallback retained |

## 14. Open questions

1. Confirm final sandbox vendor after implementation spike: E2B first, Fly
   Machines/Firecracker as fallback.
2. Confirm Cloud Run project, region, billing owner, and deployment pipeline.
3. Confirm Modal account and GPU budget guardrails.
4. Decide who labels the first 100 lead examples and where that labelled set
   lives.
5. Decide whether `content_embeddings` should stay on `384` dimensions or move
   to the existing `1536`-dimensional OpenAI embedding path before production.
6. Decide whether marketplace risk grades are shown as `low/medium/high` or a
   numeric trust score plus reasons.
7. Plan the production auth migration from shared-secret HS256 service JWTs to
   RS256 with a Lumo Core JWKS endpoint so key rotation does not require a
   coordinated Super Agent + Intelligence Layer deploy.

## 15. Decision log

| Date | Decision |
|---|---|
| 2026-04-26 | Adopt Cloud Run + Modal + E2B runtime triad |
| 2026-04-26 | Ship the brain as a privileged system agent using the normal agent contract |
| 2026-04-26 | Keep `system: true` registry-owned and ignore any partner attempt to self-declare it |
| 2026-04-26 | Make the Vegas trip flow the Phase 1 acceptance demo |
| 2026-04-26 | Keep confirmation cards as the only path to side effects |
