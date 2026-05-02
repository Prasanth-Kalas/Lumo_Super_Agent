# Contributing to `apps/ml-service/`

Conventions every Python lane on the brain must follow. PYTHON-OBSERVABILITY-1 set the precedent; everything below is enforced going forward.

## 1 · Tracing — `@traced` is mandatory

Every public function (one called from a route handler, another module, or by a Modal `@app.function()`) MUST be wrapped with `@traced("operation.name")`.

```python
from lumo_ml.core import traced, record_cost

@traced("classifier.classify", model="all-MiniLM-L6-v2")
def classify(self, user_message: str) -> IntentClassification:
    ...
```

Naming convention for `operation.name`:
- Lowercase, dotted segments, ASCII letters/digits/underscores only.
- First segment is the **module domain**: `plan.*`, `embedding.*`, `transcription.*`, `sandbox.*`, `compound.*`.
- Second segment is the **operation**: `classify`, `build`, `embed`, `optimize`.
- Optional third+ for the variant: `embedding.bge_large.batch`.

Why mandatory: lanes that ship without `@traced` create dark code paths in production. Decorator omission is a build break, not a code-review concern. CI's lint step will catch it (filed as `OBSERVABILITY-LINT-COVERAGE-1`).

## 2 · Cost — `record_cost` on every billable call

Every call that incurs LLM tokens, embedding ops, or GPU seconds MUST emit a `record_cost(...)`. Place it inside the `@traced` function so it attaches to the active span.

```python
from lumo_ml.core import record_cost, traced

@traced("embedding.bge_large")
def embed(texts: list[str]) -> list[list[float]]:
    started = time.time()
    vectors = _model.encode(texts)
    record_cost(
        "embedding.bge_large",
        embedding_ops=len(texts),
        gpu_seconds=time.time() - started,
        dollars_estimated=len(texts) * 0.00001,
        metadata={"batch_size": len(texts)},
    )
    return vectors
```

Codex's plan-client logger reads the OTel events these emit and writes rows to `agent_cost_records` — your code doesn't write to Postgres directly.

`operation` must match the regex `^[a-z][a-z0-9_.]{2,79}$`. The DB-side check enforces it; pick names that group well in dashboards.

## 3 · PII — `Secret` annotation by default

Pydantic fields containing user-derived data carry the `Secret` annotation:

```python
from typing import Annotated
from lumo_ml.core import Secret
from pydantic import BaseModel, Field

class MyRequest(BaseModel):
    user_id: str                                                   # not Secret — opaque id, queryable
    user_message: Annotated[str, Field(max_length=4000), Secret]   # ← Secret
    user_email: Annotated[str | None, Secret] = None               # ← Secret
```

Layer A: when something logs the model via `model_dump_for_logs(req)`, every `Secret`-annotated field is replaced with `"***REDACTED***"`.

Layer B (in `lumo_ml/core/pii_redaction.py`): a stdlib `logging` filter scrubs every log record's body and attributes for emails / phone numbers / credit cards (Luhn-checked) / API tokens / JWTs. Catches cases where someone forgets to use `model_dump_for_logs` and writes `logger.info(f"got: {req}")`.

**The `Secret`-by-default rule:** if a field came from user input, default to `Secret`. Opt-out (regular `str`) only for opaque identifiers (`user_id`, `session_id`), bucketed enums (`mode`, `intent_bucket`), or fields explicitly intended as queryable telemetry dimensions.

## 4 · Local-dev observability is no-op

`LUMO_OTEL_ENDPOINT` unset → SDK initializes with no exporter and `@traced` still creates spans (in-process), but nothing leaves the process. Local pytest runs have zero observability cost. Modal production gets the env via the `lumo-ml-service` Modal Secret and ships traces to Honeycomb.

## 5 · Adding a new lane

Standard sequence:

```
1. Open lane row in STATUS.md (first commit, doctrine).
2. Recon-first if the brief says so; design doc as first commit if architectural.
3. Stop for reviewer approval after recon / design.
4. Scope work in a single push: code + tests + migration (if any) + Modal redeploy + smoke.
5. Standing rebase + force-with-lease + ready-for-review.
6. FF-merge only after explicit reviewer approval.
```

See `apps/ml-service/docs/designs/observability-platform.md` for the architectural blueprint and `apps/ml-service/docs/notes/*.md` for prior recon docs. Skim those before opening a substantial lane — saves reviewer cycles and avoids re-deriving conclusions.

## 6 · Tests

Every public function gets unit tests. New observability primitives (Layer A redaction, Layer B scrubber, `@traced`, `record_cost`) have `tests/test_observability.py` as their reference test set; mirror that level of coverage for new modules.

Calibration evals (e.g. `test_intent_classifier_eval.py`, `test_system_prompt_eval.py`) are the gate for migrations from TS — keep them seeded by running the actual TS reference, not by hand-authored expected outputs.

## 7 · Schema changes

Pydantic schema changes regenerate `packages/lumo-shared-types/dist/index.ts` via codegen. CI's drift check fails any PR that changes the source without committing the regenerated TS. Run `cd packages/lumo-shared-types && python3 codegen.py` before pushing if your lane touched `lumo_ml/schemas.py` or `lumo_ml/plan/schemas.py`.
