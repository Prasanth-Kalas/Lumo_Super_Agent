# PYTHON-OBSERVABILITY-1 — observability platform design

**Status:** design-only commit. **Stop for reviewer approval before implementation begins.**
**Lane:** PYTHON-OBSERVABILITY-1
**Branch:** `claude-code-python/python-observability-1`
**Migration number:** 059 (058 is `agent_plan_compare_system_prompt`, just landed; 059 is next available).

---

## TL;DR for the reviewer

1. **Use OpenTelemetry SDK + OTLP HTTP exporter.** Vendor-agnostic; works with Honeycomb (recommended), Tempo, Datadog. Endpoint set via `LUMO_OTEL_ENDPOINT` env. **No sidecar.**
2. **W3C `traceparent` header propagation** — Vercel reads/generates one per `/api/chat`, plan-client forwards it as a header to `/api/tools/plan`, the brain parses it and creates a child span. Same pattern propagates further to Deepgram / GPU jobs.
3. **PII redaction is two-layered.** Layer A: a Pydantic `Annotated[T, Secret]` marker that replaces the field with `***REDACTED***` when serialized through Lumo's JSON encoder. Layer B: an OTel `LogProcessor` running just before the exporter that scrubs values matching email / phone / credit-card / API-token regexes from any log record's body and attribute values. **Both layers ship together** — Layer A is fast and explicit, Layer B is the unfakeable safety net for code paths that bypass the schema.
4. **Cost telemetry → new table `agent_cost_records`** (NOT an `agent_plan_compare` extension). Different cardinality (many rows per turn) and lifecycle (longer retention).
5. **`@traced` decorator + `record_cost(...)` are the only two APIs new lanes need to learn.** `lumo_ml/CONTRIBUTING.md` makes them mandatory for every new public function and every LLM/GPU/embedding call.
6. **Honeycomb free tier (20M events/month).** At ~100k turns/day × ~5 spans/turn = 15M events/month — comfortable. Tracked as **OBSERVABILITY-VOLUME-WATCH-1** in §11 with a 4× headroom alert.
7. **Sampling: 100 % for the first 30 days.** We need ground truth. After 30 days, switch to 10 % sampled with always-on for errors (5xx, slow-call > 95th percentile, anything carrying a `lumo.alert.*` attribute).

13 open questions in §11. All have a recommended default; reviewer answers lock them in.

---

## 1 · Trace propagation: W3C `traceparent`

### Why W3C `traceparent` over alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **W3C `traceparent`** (recommended) | Vendor-neutral standard, supported natively by every OTel SDK, opaque to ops engineers | None significant | ✅ |
| Datadog `x-datadog-trace-id` | Native to Datadog UI | Locks us in; conflicts when we evaluate competitors | ❌ |
| Custom `lumo-trace-id` | Full control | Re-invents OTel correlation; OTel SDK won't honour it without custom propagator | ❌ |

### Header format

```
traceparent: 00-{trace_id_hex_32}-{span_id_hex_16}-{flags_hex_2}
tracestate:  lumo=user_id:abc123,session:sess_42  [optional, vendor extras]
```

The 32-char `trace_id` is the same value that links every span in a chat turn — frontend page render, Vercel chat route, Modal `/plan`, Modal Whisper, Modal CLIP, downstream Deepgram, etc. **Joining traces across services becomes one query.**

### Lifecycle in production

```
[browser] ─POST /api/chat──────────────────────────────────────────► [Vercel TS]
                                                                        │
                                              span: chat.handle_request │ trace=abc, span=001
                                                                        │
                                              span: classify (TS)       │ trace=abc, span=002 (parent=001)
                                                                        │
                                              span: plan_client.call    │ trace=abc, span=003 (parent=001)
                                                       │ traceparent: 00-abc-003-01
                                                       ▼
                                                              [Modal Python]
                                                                        │
                                              span: plan.api            │ trace=abc, span=010 (parent=003)
                                                                        │
                                              span: classifier          │ trace=abc, span=011
                                              span: suggestions         │ trace=abc, span=012
                                              span: system_prompt       │ trace=abc, span=013
                                                                        │
                                              span: deepgram.tts        │ trace=abc, span=014 (RPC out)
                                                       │ traceparent: 00-abc-014-01
                                                       ▼
                                                                   [Deepgram]
```

Vercel TS owns `trace_id` generation if no incoming `traceparent` exists (browser doesn't send one today; future browser instrumentation could). Plan-client adds the header on every outbound HTTP call. Modal-side `LumoTracer` parses the header in a FastAPI middleware, makes the inbound span a **child of the plan-client span** (linkage), and propagates downstream.

### Implementation surface (Python side)

```python
# lumo_ml/core/observability.py
from contextlib import contextmanager
from opentelemetry import trace
from opentelemetry.propagators.textmap import default_textmap_propagator

class LumoTracer:
    """Singleton wrapper around OTel SDK. Public API is small on
    purpose so new lanes have one obvious thing to call."""

    @staticmethod
    def parse_inbound(headers: Mapping[str, str]) -> trace.Context: ...
    @staticmethod
    def start_span(name: str, *, parent: trace.Context | None = None,
                   attributes: Mapping[str, Any] | None = None) -> trace.Span: ...
    @staticmethod
    def inject_outbound(headers: dict[str, str]) -> None: ...

# Decorator wrapping any sync or async function with span creation.
def traced(operation_name: str, **default_attrs):
    def decorator(fn):
        if asyncio.iscoroutinefunction(fn):
            ...async wrapper...
        else:
            ...sync wrapper...
    return decorator
```

FastAPI middleware (one new file) attaches the inbound trace context to `request.state.trace_ctx`; route handlers decorated with `@traced("plan.api")` automatically pick it up. **No call-site change needed for existing routes — middleware + decorator do it for them.**

---

## 2 · Exporter choice — Honeycomb default

### Comparison

| Vendor | Cost | UI | Setup | Vendor lock-in | Verdict |
|---|---|---|---|---|---|
| **Honeycomb** | Free (20M events/mo), then $0.85/M | BubbleUp + tracelines, designed for high-cardinality | Single env var + API key | OTLP standard ⇒ swap is one env change | ✅ recommended |
| Grafana Tempo (self-host or Grafana Cloud) | Free (50 GB/mo on Grafana Cloud) | Tempo TraceQL good but spread across products | More — Grafana org + datasources + dashboards | OTLP ⇒ swap fine | ⚠ later, when we want unified Loki+Tempo+Mimir |
| Datadog APM | $0/host on infra plan, but APM is paid | Mature dashboards, alerts, anomaly detection | Datadog agent on every Modal container = sidecar overhead | OTLP supported via Datadog OTel collector | ⚠ revisit at Series A |
| Jaeger / Tempo self-hosted | Free | Functional but minimal | Run our own Tempo + Grafana stack — ops cost | OTLP standard | ❌ premature for foundation phase |

### Recommendation: **Honeycomb**

- Best free tier signal-to-noise for the first 30 days
- BubbleUp is uniquely good for "why is this trace slow?" queries — the foundation phase will be dominated by this question
- Switching costs are zero: change `LUMO_OTEL_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` env vars, redeploy

### Configuration

```bash
# Modal Secret: lumo-ml-service (existing). Add:
LUMO_OTEL_ENDPOINT=https://api.honeycomb.io
LUMO_OTEL_HEADERS=x-honeycomb-team=hcaik_...

# Locally for dev: same vars, optional. When unset, exporter goes
# no-op (logs to stderr at DEBUG; never blocks requests).
```

When the env is unset, the SDK silently drops events. No-network local dev still works.

---

## 3 · PII redaction — Pydantic `Secret` + log-filter pipeline

### The threat

Memory facts will eventually contain user travel history, payment-method labels, even API tokens. A naïve `logger.info(f"plan request body: {req}")` leaks all of them. A swallowed exception that prints `req.user_first_name` leaks a name. **The redaction system must work even when the developer forgets to redact.**

### Layer A — Pydantic `Annotated[T, Secret]`

```python
# lumo_ml/core/observability.py
from typing import Annotated
from pydantic import BaseModel, Field

class _SecretMarker:
    """Sentinel; presence in metadata tells our serializer to redact."""

Secret = _SecretMarker()

class UserProfile(BaseModel):
    display_name: str | None = None
    email: Annotated[str | None, Secret] = None     # ← redacted in logs
    payment_hint: Annotated[str | None, Secret] = None
```

A custom Pydantic `model_dump_for_logs()` walks the model schema, finds fields with `Secret` in their `Annotated` metadata, and replaces values with `"***REDACTED***"` before they hit any logger.

This is **fast, explicit, and self-documenting**. But it only works when the developer dumps through `model_dump_for_logs()` — `f"{model}"` or `repr(model)` would bypass it. So we need Layer B.

### Layer B — OTel `LogProcessor` regex scrubber

A processor in the export pipeline scans every log record's `body`, `attributes`, and any nested span event for substrings matching:

| Class | Regex (high level) |
|---|---|
| Email | `[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}` |
| Phone | `\+?\d[\d\-\s().]{8,}\d` |
| Credit card | `\b(?:\d[ -]*?){13,19}\b` (then Luhn check to reduce false positives) |
| Amex | `\b3[47]\d{13}\b` |
| API token (generic) | `\b(sk-\|hcaik_\|hf_\|vcp_\|pat_)[A-Za-z0-9]{16,}\b` |
| JWT | `eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}` |
| LUMO_ secret env names | `LUMO_[A-Z_]*_(SECRET\|KEY\|TOKEN)` |

Matched substrings are replaced with `***REDACTED***`. The processor runs **inside the OTel SDK between span/log capture and OTLP export**, so it cannot be bypassed by any code path that emits logs through the standard library `logging` module or `logger.error(exc_info=True)`. Custom code that writes directly to stdout/stderr would bypass it — Modal's container-log forwarder has its own scrubbing on top, addressed in §6.

Layer A drops obvious load (no need to regex-scan a known-redacted field). Layer B catches everything else.

### Test plan for redaction (gates the lane)

- Unit: `model_dump_for_logs()` strips every `Secret`-annotated field, leaves others intact.
- Unit: Layer-B processor scrubs each regex class on a synthetic log record.
- **End-to-end:** raise an exception that includes a `Secret`-annotated field in its repr, capture the OTel span via in-memory exporter, assert the field is redacted in the captured span. **This is the hard gate — fails the lane if it doesn't redact.**

### Open question: do we redact request body itself?

The `last_assistant_message` field on `PlanRequest` may include user names ("Hi Alex, when do you want to fly?"). The `memory.facts` array is even riskier. **Recommend: every nested field in `PlanRequest` that came from user data is `Secret`-annotated by default; opt-in for non-Secret only when there's a clear benefit to having it queryable.** Surfaced as 11.4 in §11.

---

## 4 · Cost telemetry — new table `agent_cost_records`

### Why a new table, not an `agent_plan_compare` extension

| Aspect | `agent_plan_compare` | `agent_cost_records` |
|---|---|---|
| Cardinality | 1 row per turn | N rows per turn (one per LLM call, embedding op, GPU job) |
| Retention | 30 days (post-cutover lanes will trim) | 90 days minimum (cost analysis is monthly) |
| Use case | Parallel-write comparison (transient) | Cost dashboard, per-user budget enforcement (durable) |
| Indexing | `(session_id, turn_id)` | `(user_id, created_at)` — different access pattern |

Forcing both into one table couples lifecycles and harms query plans. Recommend separate.

### Schema (matches brief's spec, with two precision adjustments)

```sql
-- Migration 059_agent_cost_records.sql
create table if not exists public.agent_cost_records (
  id                   bigint generated always as identity primary key,
  request_id           uuid not null,                       -- correlates to OTel trace_id (hex → uuid)
  user_id              uuid references auth.users(id) on delete set null,
  operation            text not null
                        check (operation ~ '^[a-z][a-z0-9_.]{2,79}$'),
  tokens_in            integer not null default 0
                        check (tokens_in >= 0),
  tokens_out           integer not null default 0
                        check (tokens_out >= 0),
  embedding_ops        integer not null default 0
                        check (embedding_ops >= 0),
  gpu_seconds          real    not null default 0
                        check (gpu_seconds >= 0),
  dollars_estimated    numeric(12, 6) not null default 0    -- brief said (10,4); 12,6 gives $999,999.999999 headroom
                        check (dollars_estimated >= 0),
  metadata             jsonb not null default '{}'::jsonb,  -- model name, batch size, error code; bounded query surface
  created_at           timestamptz not null default now()
);

create index agent_cost_records_by_user_time
  on public.agent_cost_records (user_id, created_at desc);
create index agent_cost_records_by_request
  on public.agent_cost_records (request_id);

comment on table public.agent_cost_records is
  'One row per cost-incurring operation (LLM token, embedding, GPU second). Append-only via row trigger; pruned at 90 days by cron.';
```

### Append-only trigger (mirrors `agent_plan_compare`)

```sql
create or replace function public.agent_cost_records_append_only()
  returns trigger language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and
     coalesce(current_setting('lumo.allow_agent_cost_records_delete', true), 'off') <> 'on'
  then
    raise exception 'agent_cost_records is append-only';
  end if;
  return null;
end;
$$;

create trigger agent_cost_records_append_only_guard
  before update or delete on public.agent_cost_records
  for each row execute function public.agent_cost_records_append_only();
```

### `record_cost()` API

```python
# lumo_ml/core/observability.py
def record_cost(
    operation: str,
    *,
    tokens_in: int = 0,
    tokens_out: int = 0,
    embedding_ops: int = 0,
    gpu_seconds: float = 0.0,
    dollars_estimated: float = 0.0,
    metadata: Mapping[str, Any] | None = None,
) -> None:
    """Emit a cost record. Attributes attached to the active span;
    persistence to ``agent_cost_records`` happens via codex's plan-
    client logger (same pattern as other parallel-write captures)."""
```

The cost record is **emitted as a span attribute + OTel event**. Codex's plan-client logger reads the events and writes the row server-side. Python doesn't write to Postgres directly — keeps the brain stateless re: user data, no auth-token plumbing. Same architecture as agent_plan_compare.

---

## 5 · Modal-side OTel — push, no sidecar

### Why no sidecar

A sidecar collector (`opentelemetry-collector-contrib`) on Modal would mean:
- Another `@app.function()` per ml-service deployment
- Another container cold-start per request — **defeats the latency goal**
- Another set of credentials to manage
- Modal's per-function billing means we pay for the sidecar even when idle

**Direct push from each function is simpler.** OTel SDK's `OTLPHTTPSpanExporter` and `OTLPHTTPLogExporter` are designed for this — they batch in-process, fire-and-forget over HTTP, and handle backpressure / timeouts internally.

### Failure modes

| Failure | Behaviour |
|---|---|
| Honeycomb endpoint times out | SDK buffers in memory, drops oldest events on overflow (ring buffer, 1024 events default). Request never blocks. |
| Honeycomb returns 4xx (auth misconfig) | SDK logs once at WARNING, drops events silently afterward. We see this in container logs. |
| Network partition | Same as timeout. |
| `LUMO_OTEL_ENDPOINT` unset | SDK no-ops. Local dev / unauthed forks still work. |

The **never-block-requests invariant** is non-negotiable. Brief target: warm `/api/tools/plan` p50 < 200 ms; OTel adds < 5 ms when healthy, ~0 ms when degraded.

### Modal Volume — not needed

OTel SDK is in-memory. No state to persist between cold starts. The `lumo-ml-models` Volume stays for sentence-transformers; nothing new.

### Stdout / stderr scrubbing

Modal's container-log forwarder captures `print()` and uncaught traceback output and ships it to Modal's own log viewer. **That bypasses our Layer-B redaction.** Two mitigations:

1. Add a `logging` handler that intercepts every `Logger` and runs Layer-B scrub before the log line hits stdout.
2. Override `sys.excepthook` so uncaught traceback frames have their `repr()`-of-locals scrubbed.

(2) is genuinely fiddly. (1) covers the common case. **Recommend ship (1) in this lane, file `OBSERVABILITY-EXCEPTHOOK-SCRUB-1` for (2).**

---

## 6 · `traced` decorator semantics

```python
@traced("classifier.classify", attributes={"model": "all-MiniLM-L6-v2"})
def classify(self, user_message: str) -> IntentClassification:
    ...
```

Behaviour:
- Creates a child span of the **current trace context** (set by FastAPI middleware on inbound requests)
- Span name = `operation_name` (the decorator argument)
- On exception, span gets `status=Error`, exception class + message attached as attributes (no traceback in attribute payload — that has too much surface; traceback is in the linked log record which goes through Layer B)
- Latency timing is automatic
- Works on sync and `async` functions

### Standardised attribute keys

To make Honeycomb queries work, attributes use a consistent schema:

| Key | Meaning |
|---|---|
| `lumo.operation` | mirror of decorator's `operation_name`, queryable across services |
| `lumo.lane` | optional, set per call: `"plan.api"`, `"classifier.classify"` |
| `lumo.user_id` | end-user id (already-redacted form is fine — this is for span correlation, never leaves Honeycomb) |
| `lumo.session_id` | session id |
| `lumo.bucket` | `fast_path` / `tool_path` / `reasoning_path` |
| `lumo.error.code` | structured error string |
| `lumo.cost.tokens_in` / `lumo.cost.tokens_out` / `lumo.cost.dollars` | cost record dimensions, doubled into spans for query convenience |

A fixed key namespace — adding a new attribute means thinking about whether it's `lumo.*` or vendor-specific. **Documented in `apps/ml-service/CONTRIBUTING.md` per the brief.**

---

## 7 · Sampling

Brief says "Acceptance: /api/tools/plan request shows up as a complete trace". To get reliable visibility for the first 30 days, **100 % sampling**. After that, switch to:

| Class | Rate |
|---|---|
| Errors (5xx, span status=Error) | 100 % |
| Slow calls (> 95th percentile latency) | 100 % |
| Spans with `lumo.alert.*` attribute | 100 % |
| Everything else | 10 % |

The 30-day cutover is a follow-up: `OBSERVABILITY-SAMPLING-CUTOVER-1`.

---

## 8 · Volume budget — tracked as `OBSERVABILITY-VOLUME-WATCH-1`

Honeycomb free tier: **20 M events/month**.

Estimate at current scale (rough, pre-cutover):
- ~5 spans per `/api/tools/plan` turn (route + classifier + suggestions + system_prompt + cost-record event)
- ~100 k turns/day estimate
- = 15 M events/month → **75 % of free tier**

Headroom is tight. Triggers:

- 16 M events/month → file `OBSERVABILITY-SAMPLING-CUTOVER-1` urgently
- 19 M events/month → enable 10 % sampling immediately (don't wait for the lane)
- 4 × current traffic (60 M/month) → upgrade to Honeycomb paid ($0.85/M after 20M = ~$34/month)

Filed as `OBSERVABILITY-VOLUME-WATCH-1` — a recurring weekly check, not a one-shot lane.

---

## 9 · `CONTRIBUTING.md` — the discipline rule

After this lane lands, every Python lane PR must satisfy:

> Every public function (one called from a route handler or another module) MUST be wrapped with `@traced("operation.name")`. Every call that incurs LLM tokens, embedding ops, or GPU seconds MUST emit a `record_cost(...)`. CI's `ruff` config will gain a custom check (`scripts/check_traced_coverage.py`) that fails when a public function in `lumo_ml/` is missing `@traced`. Decorator omission is a build break, not a code-review concern.

**Trade-off:** this slows every new lane by 2-5 minutes of decorator-wiring. The alternative (untraced lanes shipping for two weeks then back-instrumenting under fire when production breaks) is much worse. Brief explicitly mandates this; doc reflects it.

---

## 10 · Implementation surface preview (subject to design approval)

```
apps/ml-service/
├── lumo_ml/
│   └── core/                         # NEW — cross-cutting infrastructure
│       ├── __init__.py
│       ├── observability.py          # LumoTracer, traced, record_cost, Secret
│       ├── pii_redaction.py          # Layer-A model_dump_for_logs + Layer-B regex scrubber
│       └── otel_setup.py             # OTel SDK init, exporter wiring, FastAPI middleware
├── lumo_ml/main.py                   # add observability middleware + init
├── lumo_ml/plan/router.py            # @traced on route_plan
├── lumo_ml/plan/classifier.py        # @traced on classify
├── lumo_ml/plan/suggestions.py       # @traced on build_assistant_suggestions
├── lumo_ml/plan/system_prompt.py     # @traced on build_system_prompt
├── lumo_ml/CONTRIBUTING.md           # NEW — discipline rule
├── tests/test_observability.py      # NEW — 25+ tests for Secret, regex scrubber, traced, record_cost
└── pyproject.toml                    # adds opentelemetry-api/sdk/exporter-otlp-http
db/migrations/059_agent_cost_records.sql  # NEW
```

New deps: `opentelemetry-api`, `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`, `opentelemetry-instrumentation-fastapi`. ~3 MB total. Pyproject delta is minimal.

---

## 11 · Open questions for reviewer

### 11.1 — Exporter: Honeycomb (default), Tempo, or Datadog?
**Recommend Honeycomb.** Cheap, ergonomic, OTLP-standard so swapping is trivial. Default if no answer.

### 11.2 — `tracestate` (vendor extras like `lumo=user_id:abc123`) in scope this lane?
Brief mentions `traceparent` only. **Recommend `traceparent` only for v1.** `tracestate` adds a parsing surface and a vendor-coupling risk. File `OBSERVABILITY-TRACESTATE-EXTRAS-1` for when we need vendor-specific signals.

### 11.3 — Cost storage: new `agent_cost_records` table or `agent_plan_compare` extension?
Recon §4 lays out cardinality + lifecycle differences. **Recommend new table.** This is the strongest of the recommendations.

### 11.4 — PII redaction default for `PlanRequest` user-derived fields
Should every nested field that originated from user data be `Secret`-annotated by default (opt-out for queryable telemetry), or only fields the developer remembers? **Recommend default-Secret** — inverts the failure mode from "leak by forgetting to mark" to "lose a queryable field by forgetting to opt out". Either is auditable; default-secret is safer.

### 11.5 — Sampling rate for first 30 days
**Recommend 100 %** — we need ground truth before sampling. After 30 days, switch to errors + tail-latency + 10 % baseline. Is 30 days the right window or should we sample sooner?

### 11.6 — Modal stdout / stderr scrubbing
Layer-B scrub via a custom `logging.Handler`. Excepthook scrub for uncaught traceback locals = `OBSERVABILITY-EXCEPTHOOK-SCRUB-1` deferred. **OK to defer the excepthook?** Recommend yes; uncaught exceptions in the brain are rare enough that the value is small for the engineering cost.

### 11.7 — Cost field precision — `numeric(10,4)` (brief) vs `numeric(12,6)` (recommend)
At 100 k turns/day × $0.001 each = $100/day = $36 k/year. `numeric(10,4)` overflows at $999,999.9999 — fine for per-row, BUT monthly aggregations could overflow. **Recommend `numeric(12,6)`** for headroom.

### 11.8 — `lumo_ml/core/` is a new directory
Confirm naming: `lumo_ml/core/` (recommended) vs `lumo_ml/observability/` vs `lumo_ml/_internal/`. Recon-style choice; `core` matches "shared infrastructure for downstream modules".

### 11.9 — `request_id` correlation
The brief specifies `request_id uuid` on `agent_cost_records`. OTel's `trace_id` is a **128-bit hex string**, naturally maps to UUID. Recommend storing the trace_id as the request_id (no separate ID generation). One open: do we ALSO want the span_id for finer-grain correlation? Recommend yes — add `span_id text` to `agent_cost_records`.

### 11.10 — `metadata jsonb` field on `agent_cost_records`
The brief's spec is rigid — fixed columns only. I added a `metadata jsonb default '{}'` for things we'll wish we had later (model name, batch size, error code). **Acceptable to widen the brief here?** Recommend yes; jsonb adds zero migration cost vs. needing a 060/061/062 to add new fixed columns later.

### 11.11 — `@traced` failure mode: blocking vs no-op
If OTel SDK throws in `start_span` (memory pressure, weird state), should `@traced` propagate the exception and break the wrapped function, or swallow it and call the function untraced? **Recommend swallow + log once at WARNING.** Tracing should never break business logic.

### 11.12 — Honeycomb API key storage
Bootstrap into the existing `lumo-ml-service` Modal Secret. **Recommend yes**, alongside `LUMO_ML_SERVICE_JWT_SECRET` and `HF_TOKEN`. Bootstrap script gains `HONEYCOMB_API_KEY` as a third optional input.

### 11.13 — Trace ID propagation TO Modal (HTTP header) AND FROM Modal (downstream calls)
The brief covers Vercel→Modal. What about Modal→Deepgram, Modal→Modal-GPU-Whisper? Honeycomb supports federated tracing — Deepgram is unlikely to honor `traceparent` (third-party), but Modal-internal calls absolutely should. **Recommend instrument all out-of-process calls in Python with `inject_outbound(headers)`.** File `OBSERVABILITY-MODAL-GPU-PROPAGATION-1` for the Whisper/CLIP wiring once those flows have load worth tracing.

---

## 12 · Implementation plan (subject to reviewer answers)

Assuming defaults: **Honeycomb / traceparent only / new cost table / default-Secret for user data / 100 % sampling / Layer-B logging handler ship now, excepthook deferred / numeric(12,6) / `lumo_ml/core/` / request_id = trace_id + new span_id / jsonb metadata / @traced swallow + WARN / Honeycomb key in Modal Secret / file Modal-internal propagation follow-up.**

Single-push scope (after design approval):

1. **`lumo_ml/core/observability.py`** — `LumoTracer`, `@traced`, `record_cost`, `Secret`, `model_dump_for_logs`.
2. **`lumo_ml/core/pii_redaction.py`** — Layer-A serializer + Layer-B regex scrubber (LogProcessor).
3. **`lumo_ml/core/otel_setup.py`** — SDK init, OTLP HTTP exporter, FastAPI middleware.
4. **`lumo_ml/main.py`** — wire middleware + SDK init; one new line in app construction.
5. **`@traced` on existing endpoints**: `route_plan`, `classify`, `build_assistant_suggestions`, `build_system_prompt`. ~5 LOC delta.
6. **Migration 059** — `agent_cost_records` + append-only trigger + indexes.
7. **`pyproject.toml`** — three OTel packages.
8. **`bootstrap-modal-secrets.sh`** — gain `HONEYCOMB_API_KEY` optional input.
9. **`apps/ml-service/CONTRIBUTING.md`** — discipline rule + `@traced` example + cost-record example.
10. **Tests** (`tests/test_observability.py`):
    - Layer A: `Secret`-annotated field redacted in `model_dump_for_logs()`
    - Layer B: each regex class scrubbed on synthetic log records
    - End-to-end: exception with `Secret` field appears redacted in captured span
    - `@traced` works on sync and async functions
    - `record_cost` attaches attributes to active span
    - SDK no-op when `LUMO_OTEL_ENDPOINT` unset
    - Trace context propagates from inbound `traceparent` header
11. **Smoke test on Modal**: `curl /api/tools/plan`, verify a complete trace appears in Honeycomb with the 4 expected child spans.

12. **TS-side coordination**: file `TS-OTEL-PROPAGATION-1` for codex queue. Not implementing anything in `apps/web/` per CLAUDE.md scope.

---

## 13 · Coordination + scope discipline

- **Codex follow-up**: `TS-OTEL-PROPAGATION-1` — extend `apps/web/lib/lumo-ml/plan-client.ts` to inject `traceparent` header on outbound calls. Required for the trace stitching to actually work in production. Filed but not blocking this lane (Python side ships independently; trace shows up as orphan spans until codex's lane lands, which is a useful intermediate state).
- **iOS follow-up**: deferred. iOS doesn't currently call `/api/tools/plan` directly — when it does (Phase 3 voice path), file `IOS-OTEL-PROPAGATION-1`.
- **Modal-internal follow-up**: `OBSERVABILITY-MODAL-GPU-PROPAGATION-1` — propagate `traceparent` into the Whisper / CLIP function invocations from `lumo_ml/transcription.py` and `lumo_ml/image_embedding.py` once those have production load.
- **Sampling cutover follow-up**: `OBSERVABILITY-SAMPLING-CUTOVER-1` — after 30 days at 100 % sampling, switch to error+tail+10%-baseline.
- **Volume watch**: `OBSERVABILITY-VOLUME-WATCH-1` — recurring weekly check on Honeycomb event count.
- **Excepthook scrub**: `OBSERVABILITY-EXCEPTHOOK-SCRUB-1` — `sys.excepthook` override for uncaught-traceback locals scrubbing.

---

## 14 · What I'm waiting on before scope work

1. Exporter choice (11.1) — recommend **Honeycomb**.
2. `tracestate` in scope (11.2) — recommend **out**.
3. Cost storage (11.3) — recommend **new table**.
4. Default-Secret on PlanRequest user fields (11.4) — recommend **yes, opt-out for queryable**.
5. Sampling rate (11.5) — recommend **100 % for 30 days**.
6. Excepthook scrub deferral (11.6) — recommend **yes, defer**.
7. Cost precision (11.7) — recommend **`numeric(12,6)`**.
8. Directory naming (11.8) — recommend **`lumo_ml/core/`**.
9. `request_id = trace_id` + add `span_id` (11.9) — recommend **yes**.
10. `metadata jsonb` on cost table (11.10) — recommend **yes**.
11. `@traced` swallow vs raise (11.11) — recommend **swallow + log once**.
12. Honeycomb key in Modal Secret (11.12) — recommend **yes**.
13. Modal-internal propagation in this lane (11.13) — recommend **out, file follow-up**.

Once those are answered (or reviewer green-lights defaults), scope work proceeds in a single push.
