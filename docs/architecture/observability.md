# Observability

How Lumo tells operators what it's doing.

## Principles

- **Boring telemetry beats clever telemetry.** We write plain counters and durations to Postgres and read them with normal SQL. No APM vendor, no tracing tangle.
- **Every cron is a citizen.** If a job runs, it records the fact. If a job is unhealthy, the dashboard shows it.
- **User-scoped data is user-visible.** The user's action log at `/autonomy` uses the same `autonomous_actions` table the ops dashboard surfaces — same source of truth, different filters.

## The `ops_cron_runs` table

Introduced in migration 008. One row per cron invocation:

```
id            uuid PK
endpoint      text        'proactive-scan' | 'evaluate-intents' | 'detect-patterns'
started_at    timestamptz when the handler began
finished_at   timestamptz when the handler ended (null if still running or crashed)
ok            boolean     did it reach the stable completion path?
counts        jsonb       per-run stats (e.g. { users_scanned: 42, triggered: 3 })
errors        jsonb       array of error objects if ok=false
```

`lib/ops.ts::recordCronRun(endpoint, fn)` wraps any cron body:

```ts
export async function recordCronRun<T>(
  endpoint: string,
  fn: (addCount: (k: string, n: number) => void) => Promise<T>,
): Promise<T> {
  const runId = await insertRun(endpoint);
  const counts: Record<string, number> = {};
  const addCount = (k: string, n: number) =>
    (counts[k] = (counts[k] ?? 0) + n);
  try {
    const result = await fn(addCount);
    await finishRun(runId, { ok: true, counts });
    return result;
  } catch (err) {
    await finishRun(runId, {
      ok: false,
      counts,
      errors: [{ message: String(err), stack: (err as Error)?.stack }],
    });
    throw err;
  }
}
```

Every `app/api/cron/*` handler wraps itself in this helper, so the table populates automatically.

## The `/ops` dashboard

Admin-gated page (`app/ops/page.tsx`). Access is controlled by `LUMO_ADMIN_EMAILS` — a comma-separated list of emails in env. Signed-in users whose email is in the list see the dashboard; everyone else gets a 403.

Sections:

**Cron health cards.** One per cron endpoint. Each shows:
- Current status (green if last run was within 2× the cron interval and `ok=true`; amber if late; red if failing).
- Last 20 runs as a sparkline — bar height = duration (ms), color = ok/fail.
- Error summary if any recent failure.

**Autonomy activity.** Aggregates from `autonomous_actions` over the last 7 days:
- Count of autonomous actions per day (bar chart).
- Top 10 tools by invocation count.
- Spend totals (today / this week / this month).

**Notification stats.** From `notifications`:
- Total sent per day.
- Breakdown by `kind`.
- Read rate (percentage marked read within 24 hours).

**Pattern stats.** From `user_behavior_patterns`:
- Patterns added in the last 24 hours.
- Most common pattern strings (fuzzy-grouped) — tells you what Lumo is noticing about your users at an aggregate level.

## The `/api/ops/summary` endpoint

Server-side feed for the dashboard. Same admin gate. Returns a JSON blob:

```json
{
  "cron_health": [
    { "endpoint": "proactive-scan", "last_run": "...", "ok": true, "p95_duration_ms": 420 },
    ...
  ],
  "autonomy_stats": {
    "actions_today": 18,
    "actions_week": 92,
    "spend_today_cents": 4520,
    "top_tools": [{ "tool": "flight_book", "count": 12 }, ...]
  },
  "notification_stats": { ... },
  "pattern_stats": { ... }
}
```

If you want a Grafana or custom dashboard, this JSON is the stable API surface. The ops page just renders it client-side.

## Application-level logs

Everything `console.log` / `console.warn` / `console.error` in the app flows to Vercel's log drain (or whatever your host uses). Log hygiene guidelines enforced in code review:

- **Errors** → `console.error(context, err)`. Include structured context (user_id, tool, agent_id) so logs are greppable.
- **Warnings** → `console.warn("[module] short description:", detail)`. Used for graceful-degrade paths (e.g. "ElevenLabs auth failed, falling back to browser TTS").
- **Info** → `console.info("[module] transition info")`. Used sparingly; not for per-request noise.
- **Never `console.log`.** Kept for ad-hoc debugging; linter flags it. Production code uses the leveled variants.

## What we explicitly do NOT log

- **Conversation content.** No user messages, no assistant responses, no tool arguments. The event table records tool names and outcomes, never payloads.
- **OAuth tokens** (encrypted or plain).
- **Provider content** (emails, events, tracks).

This is a deliberate choice aligned with the privacy posture in [users/privacy.md](../users/privacy.md). If you need deeper debugging, use a local dev environment with a test account; don't turn on content logging in production.

## Metrics worth watching

If you're setting up alerts against the ops data, the ones that have mattered in practice:

- **Cron latency p95 > 2× baseline** → usually means Supabase is struggling or a particular user's memory blob is too big. Indicates work for the ops team before it turns into a visible-to-users problem.
- **Cron `ok=false` rate > 5% over 24 hours** → something's systemically broken; dig into `errors` column.
- **Autonomous action failure rate > 10%** (from `autonomous_actions.outcome='failed'`) → either an agent is misbehaving or a provider is having issues. Cross-reference with agent health.
- **Notification write rate spike (> 10× baseline)** → a standing-intent trigger is misbehaving platform-wide, or a platform rule is firing too liberally.

## Python ML service observability platform (May 2026)

Lane `PYTHON-OBSERVABILITY-1` shipped a parallel observability layer specifically for the Modal-hosted Python ML service (`apps/ml-service/lumo_ml/`). The Vercel/TS side still uses the boring Postgres-backed approach above; the Python side uses OpenTelemetry → Honeycomb because Modal's serverless function model + GPU work needs distributed tracing in a way the cron-counter approach can't deliver.

### Architecture

```
[Vercel /api/chat or /api/tools/plan]
   │   traceparent header
   ▼
[Modal Python /api/tools/plan]
   │   FastAPIInstrumentor extracts traceparent → child spans
   ▼
[plan.api → plan.classifier.classify → plan.suggestions.build → plan.system_prompt.build]
   │   each function @traced; record_cost() emits span events
   ▼
[OTLP HTTP exporter → Honeycomb US]
   │
   ▼
[Honeycomb dashboards: trace tree, cost breakdown, error rate]
```

### The discipline rule

Every public function in `lumo_ml/` (excluding tracing-infra files) must carry the `@traced` decorator. Enforced by CI lint at `apps/ml-service/scripts/lint-traced-coverage.py`. Bare `# noqa: TRC001` is rejected; opt-out requires an inline reason. See `apps/ml-service/CONTRIBUTING.md §1`.

### Three primitives

```python
from lumo_ml.core.observability import traced, record_cost
from lumo_ml.core.pii_redaction import Secret

class PlanRequest(BaseModel):
    user_message: Annotated[str, Secret]   # redacted in logs/traces
    user_id: str                           # opt-out, queryable

@traced("plan.classifier.classify")
async def classify(request: PlanRequest) -> IntentBucket:
    ...
    record_cost(
        operation="classify",
        tokens_in=len(text),
        embedding_ops=1,
        dollars_estimated=0.000117 * len(text) / 1000,
    )
    return bucket
```

- **`@traced(name)`** — sync + async support; child of active context; exceptions recorded; SDK errors swallowed (tracing must never break business logic).
- **`record_cost(...)`** — span-attached event for LLM tokens, embedding ops, GPU seconds, dollars. Codex's plan-client logger reads these events and writes rows to migration 059's `agent_cost_records` table.
- **`Secret` marker** — Pydantic `Annotated[T, Secret]` + `model_dump_for_logs(model)`. Plus a stdlib logger filter (Layer B) running between log capture and OTLP export — unfakeable from any code path.

### PII redaction

Two layers, both ship together:

- **Layer A (explicit):** Pydantic field-level `Annotated[T, Secret]`. Fast, opt-in at schema-definition time. `ChatTurn.content`, `UserProfile.display_name`, `UserFact.fact`, `PlanRequest.user_first_name` are Secret-by-default per `Q11.4`. Opt-out (regular `str`) for opaque IDs (`user_id`, `session_id`), bucketed enums (`mode`, `intent_bucket`), and queryable lists (dietary flags).
- **Layer B (defensive):** Stdlib `logging.Filter` running on every log record. Six PII regex classes — email, phone-with-separators, Luhn-validated CC, Amex, API tokens, JWTs — replace matches with `"***REDACTED***"` before OTLP export.

**Known gap (filed):** OTel's `record_exception` captures raw exception messages verbatim. Layer B doesn't currently scrub those. Test `test_secret_marked_value_does_not_leak_into_span_via_exception` asserts the gap; closes with lane `OBSERVABILITY-SPAN-EXCEPTION-SCRUB-1`.

### Cost telemetry

Migration 059 added `agent_cost_records`:

```
id              bigserial PK
created_at      timestamptz not null default now()
request_id      uuid (= trace_id)
span_id         text
operation       text       'classify' | 'suggestions.build' | 'system_prompt.build' | 'embed' | ...
tokens_in       int
tokens_out      int
embedding_ops   int
gpu_seconds     real
dollars_estimated  numeric(12,6)
metadata        jsonb      arbitrary span tags
user_id         uuid references auth.users on delete set null
```

Every `record_cost()` call lands one row here via codex's plan-client logger. Per-user cost dashboards (`COST-DASHBOARD-1`) are deferred until baseline data accumulates.

### Trace propagation across surfaces

W3C `traceparent` headers stitch a single trace across Vercel + Modal. `FastAPIInstrumentor` on the Modal side auto-extracts inbound `traceparent`; codex's plan-client (`apps/web/lib/lumo-ml/plan-client.ts`) injects on outbound calls (when `TS-OTEL-PROPAGATION-1` follow-up lands). Same `trace_id` joins every span across the stack — one Honeycomb query reveals end-to-end latency per chat turn.

### Sampling

100% sampling for the first 30 days post-launch (`PYTHON-OBSERVABILITY-1` Q11.5) to maximize visibility while we learn the system's normal behavior. Switches to errors + tail-latency + 10% baseline via `OBSERVABILITY-SAMPLING-CUTOVER-1` after the watch window. Honeycomb free-tier ceiling at 20M events/month is monitored weekly via `OBSERVABILITY-VOLUME-WATCH-1`.

### Files of interest

- `apps/ml-service/lumo_ml/core/observability.py` — `@traced`, `record_cost`, OTLP setup
- `apps/ml-service/lumo_ml/core/pii_redaction.py` — Layer B logger filter, Secret marker
- `apps/ml-service/lumo_ml/core/otel_setup.py` — TracerProvider + exporter wiring
- `apps/ml-service/scripts/lint-traced-coverage.py` — CI discipline enforcement
- `apps/ml-service/CONTRIBUTING.md` — written rule + opt-out semantics
- `db/migrations/059_agent_cost_records.sql` — cost storage schema

## Related

- [data-model.md](data-model.md#ops_cron_runs-migration-008) — table schema.
- [proactive-engine.md](proactive-engine.md) — the crons being observed.
- [operators/incident-runbook.md](../operators/incident-runbook.md) — what to do when these signals go bad.
- [docs/designs/observability-platform.md](../designs/observability-platform.md) — full design doc for the Python platform.
