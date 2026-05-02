# Embedding service — design

**Lane:** `PYTHON-EMBEDDING-SERVICE-1`
**Branch:** `claude-code-python/python-embedding-service-1`
**Stacked on:** `origin/main` (post `OBSERVABILITY-LINT-COVERAGE-1` merge)
**Paired with:** [`vector-store.md`](./vector-store.md) — `PYTHON-VECTOR-STORE-1`
**Status:** design-only commit. Stop here for reviewer approval before any model-loading or Modal-deploy code lands.

---

## TL;DR for the reviewer

A single-model text-embedding primitive at `apps/ml-service/lumo_ml/core/embeddings.py`. BGE-large-en-v1.5 (1024-dim, L2-normalized, MIT-licensed), served via Modal under T4 mirroring `modal_clip.py`. Two public functions — `embed_text(str)` and `embed_batch(list[str])` — each wrapped in `@traced` and emitting `record_cost`. The `Embedding` Pydantic schema carries a `model_version` Literal pinned to `"bge-large-en-v1.5"`; `PYTHON-VECTOR-STORE-1` keys off that exact literal so a vector cannot land in storage with a model contract its consumer doesn't recognize.

The brief's NEW REQUIREMENT — CI lint must break the PR if any public function in `lumo_ml/core/embeddings.py` is missing `@traced` — directly contradicts CONTRIBUTING §1.1 ("`lumo_ml/core/` is permanently out of scope; tracing the tracer is circular"). Recommendation: invert the exemption from "whole directory" to "named tracing-infra files only" (§6 below). Same change unblocks `PYTHON-VECTOR-STORE-1` and every future cross-cutting primitive that lands in `core/`.

11 open questions in §9 — all have a recommended default. Reviewer answers lock them in. Implementation lands as a single push once approved.

---

## 1 · Model choice: BGE-large-en-v1.5

**Locked by brief.** Documenting the why so it's auditable.

| Property                | Value                                                          |
|-------------------------|----------------------------------------------------------------|
| HuggingFace ID          | `BAAI/bge-large-en-v1.5`                                       |
| Output dimensions       | 1024                                                           |
| Normalization           | L2 — cosine similarity ≡ dot product → faster HNSW             |
| Tokenizer               | XLM-RoBERTa-base (BGE's tokenizer; ~14 tokens / short query)   |
| Max sequence length     | 512 tokens                                                     |
| Model size              | ~1.3 GB on disk (~1.7 GB peak GPU memory mid-inference)        |
| License                 | MIT                                                            |
| MTEB English retrieval  | Top of class among <1B-param models at brief time              |

**Why BGE-large over alternatives we already touch:**

- `all-MiniLM-L6-v2` (384-dim, used by `IntentClassifier`) is fast but retrieval-quality lower; fine for a 4-class intent head, not for the recall-focused workload `vector-store` exists to serve.
- `BGE-base-en-v1.5` (768-dim) is the middle ground; brief picked large for retrieval ceiling.
- OpenAI `text-embedding-3-large` (3072-dim) is external, $$$, network-bound, and pulls a fresh dependency surface — declined.
- The existing `unified_embeddings` table (migration 032) is already `vector(1024)` with HNSW `m=16 / ef_construction=64`. BGE-large slots into the dimensionality decision codex sealed in ADR-011 §4 — same shape across the substrate, no projection layer needed.

**Why not multiple models behind the same primitive:** every additional model_version doubles the schema-validation surface for `vector_store` and forces a query-time model-routing decision that has no caller right now. v1 ships single-model. A second model is a separate lane (e.g. `EMBEDDING-MULTILINGUAL-ADD-1`) once a use case fires.

---

## 2 · Serving: Modal T4 mirroring `modal_clip.py`

The serving precedent across `modal_clip.py` (CLIP, T4) and `modal_whisper.py` is "one Modal app file per model, GPU-resident, called from a thin local wrapper that handles auth + telemetry." Embedding service follows.

**Modal function shape** (final form pending Q1/Q2 answers):

```python
# apps/ml-service/lumo_ml/modal_bge.py
import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("sentence-transformers>=3.2.0", "torch>=2.2.0")
)

app = modal.App("lumo-bge-large")
weights_volume = modal.Volume.from_name("lumo-bge-weights", create_if_missing=True)


@app.function(
    image=image,
    gpu="T4",
    timeout=2 * 60,
    scaledown_window=120,            # longer than CLIP's 60s — text traffic burstier
    volumes={"/weights": weights_volume},
)
def embed_batch_remote(texts: list[str], instruction: str | None) -> list[list[float]]:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("BAAI/bge-large-en-v1.5", cache_folder="/weights")
    if instruction:
        texts = [f"{instruction}: {t}" for t in texts]
    return model.encode(texts, normalize_embeddings=True).tolist()
```

**Cold-start budget:** ~10–15 s on first invocation per container (model load from `/weights` Modal Volume; weights download from HF only on the very first cold start ever, then cached in the Volume). Subsequent invocations within `scaledown_window` are warm.

**Warm latency budget:**

| Batch size | Per-text latency | Per-call latency |
|------------|------------------|------------------|
| 1          | ~40 ms           | ~40 ms           |
| 8          | ~12 ms           | ~95 ms           |
| 32         | ~6 ms            | ~190 ms          |
| 64         | ~5 ms            | ~310 ms          |

(Synthetic — to be confirmed by the latency-budget test in the implementation lane.)

**T4 memory headroom:** BGE-large is ~1.7 GB peak; T4 has 16 GB. Batch=64 of 512-token inputs fits comfortably. Q3 below confirms the cap.

**Why not a separate Modal app vs co-locating in `modal_app.py`:** the precedent (CLIP, Whisper) is one-file-per-model, and the deploy story for a single Modal `App` per model is independently versionable and rollback-friendly. Default to a new `modal_bge.py` (Q1).

---

## 3 · Public surface (Pydantic + functions)

```python
# apps/ml-service/lumo_ml/core/embeddings.py
from typing import Annotated, Literal
from pydantic import BaseModel, Field, field_validator
from lumo_ml.core import Secret, traced, record_cost

ModelVersion = Literal["bge-large-en-v1.5"]
DIMENSIONS: int = 1024


class Embedding(BaseModel):
    values: list[float] = Field(..., min_length=DIMENSIONS, max_length=DIMENSIONS)
    model_version: ModelVersion = "bge-large-en-v1.5"
    dimensions: int = DIMENSIONS
    normalized: bool = True


class EmbedTextRequest(BaseModel):
    text: Annotated[str, Secret] = Field(..., min_length=1, max_length=8192)
    instruction: str | None = None    # BGE retrieval-instruction prefix (Q4)


class EmbedBatchRequest(BaseModel):
    texts: list[Annotated[str, Secret]] = Field(..., min_length=1, max_length=64)
    instruction: str | None = None

    @field_validator("texts")
    @classmethod
    def _no_empty_items(cls, v: list[str]) -> list[str]:
        if any(not t.strip() for t in v):
            raise ValueError("texts contains empty/whitespace-only entries")
        return v


class EmbedTextResponse(BaseModel):
    embedding: Embedding
    tokens_consumed: int               # source-of-truth from BGE tokenizer (Q5)


class EmbedBatchResponse(BaseModel):
    embeddings: list[Embedding]
    tokens_consumed: int


@traced("embedding.bge_large.embed_text")
async def embed_text(req: EmbedTextRequest) -> EmbedTextResponse: ...


@traced("embedding.bge_large.embed_batch")
async def embed_batch(req: EmbedBatchRequest) -> EmbedBatchResponse: ...
```

**Why `Annotated[str, Secret]` on text inputs:** user text may contain PII. The `Secret` marker (PYTHON-OBSERVABILITY-1 Layer A) makes `model_dump_for_logs` redact text in any log line that goes through the Pydantic-aware serializer. Layer B (regex scrubber) catches anything that bypasses Layer A.

**Why async-only public surface:** Modal's `.remote.aio()` is the natural shape; sync wrappers add `asyncio.run()` foot-guns and surprise-deadlocking for callers already inside an event loop (e.g. FastAPI handlers). Q6.

---

## 4 · Cost telemetry

The brief: *"record_cost on every embedding call (count: dollars per 1M tokens for BGE-large-en-v1.5)."*

BGE-large isn't a billed-per-token API — we run it ourselves on Modal T4. The natural cost basis is GPU-seconds. The brief's "dollars per 1M tokens" framing is a synthetic mapping for dashboard parity with token-billed peers (Anthropic, OpenAI). The mapping:

| Input                                       | Value                                       |
|---------------------------------------------|---------------------------------------------|
| Modal T4 list price                          | $0.000164 / GPU-second                      |
| Throughput (batched, T4, BGE-large)         | ~1400 tokens / GPU-second                    |
| Implied dollars / 1M tokens                  | **~$0.117**                                  |

(Confirmed during implementation; for the schema's `DOLLARS_PER_M_TOKENS` constant.)

**`record_cost` payload per call:**

```python
record_cost(
    "embedding.bge_large",
    embedding_ops=len(req.texts),
    gpu_seconds=elapsed,
    dollars_estimated=tokens_consumed * DOLLARS_PER_M_TOKENS / 1_000_000,
    metadata={
        "batch_size": len(req.texts),
        "model_version": "bge-large-en-v1.5",
        "instruction_prefix": bool(req.instruction),
    },
)
```

Codex's plan-client logger persists this into `agent_cost_records` (migration 059) — no Postgres write from Python.

**Cost calibration cadence (Q11):** Modal pricing drifts; a hard-coded `DOLLARS_PER_M_TOKENS` rots silently. Recommend filing `EMBEDDING-COST-CALIBRATION-SWEEP-1` as a quarterly recurring agent that re-measures throughput on canonical fixtures and updates the constant via PR.

---

## 5 · @traced surface

Every public function in `lumo_ml/core/embeddings.py` is `@traced`. Two public functions today:

| Function       | `@traced` operation               |
|----------------|-----------------------------------|
| `embed_text`   | `embedding.bge_large.embed_text`  |
| `embed_batch`  | `embedding.bge_large.embed_batch` |

The `_load_model` / `_pick_instruction_prefix` helpers stay private (`_`-prefixed) so the lint skips them naturally.

**`record_cost` is called inside the `@traced` body** so it attaches to the active span, per CONTRIBUTING §2's worked example.

---

## 6 · Lint-scope refinement (resolves the brief / CONTRIBUTING contradiction)

**The contradiction.** CONTRIBUTING §1.1 (post-`PYTHON-OBSERVABILITY-1`) says:

> `lumo_ml/core/` is permanently out of scope — that module *is* the tracing infrastructure (`@traced`, `record_cost`, `Secret`); tracing the tracer is circular noise.

Brief NEW REQUIREMENT:

> CI lint will break the PR if any public function in `lumo_ml/core/embeddings.py` or `lumo_ml/core/vector_store.py` is missing `@traced`.

Both lanes' files live in `lumo_ml/core/`, which is currently exempt at directory granularity.

**Three resolution options considered:**

| Option | Mechanism                                                                                                  | Verdict     |
|--------|-------------------------------------------------------------------------------------------------------------|-------------|
| (a)    | Add `lumo_ml/core/embeddings.py` (+ `vector_store.py`) to `DEFAULT_TARGETS` as **specific files**.          | Awkward — directory-mostly-excluded-except-this-one-file pattern won't survive growth. |
| (b)    | **Invert.** Widen `DEFAULT_TARGETS` to include `lumo_ml/core/` wholesale; add the three tracing-infra files (`observability.py`, `otel_setup.py`, `pii_redaction.py`) to `SCOPE_FILE_EXCLUDES`. | **Recommended.** Directory in scope by default; named infra files exempt. Future-proofs every cross-cutting primitive that lands in `core/`. |
| (c)    | Move the file out of `core/` entirely (e.g. `lumo_ml/embedding/embeddings.py` per CONTRIBUTING §1.1's worked example). | Off the table — brief locks the path. |

**Recommended path (b)** changes:

1. `apps/ml-service/scripts/lint-traced-coverage.py`:
   - `DEFAULT_TARGETS = ("lumo_ml/plan", "lumo_ml/core")` *(was: `("lumo_ml/plan",)`)*
   - `SCOPE_FILE_EXCLUDES |= {"lumo_ml/core/__init__.py", "lumo_ml/core/observability.py", "lumo_ml/core/otel_setup.py", "lumo_ml/core/pii_redaction.py"}`
2. `apps/ml-service/CONTRIBUTING.md` §1.1 — flip the "permanently out of scope" wording. New text:
   > `lumo_ml/core/` is in scope by default. The tracing-infra files themselves (`observability.py`, `otel_setup.py`, `pii_redaction.py`) are exempt — tracing the tracer is circular — but every other module in `core/` (cross-cutting domain primitives like `embeddings.py`, `vector_store.py`) MUST honor the discipline.
3. Lint regression-test fixtures gain a "`core/` non-infra file requires `@traced`" case so the boundary doesn't drift.

**This refinement ships as part of `PYTHON-EMBEDDING-SERVICE-1` (Q8).** Reasoning:
- Embedding-service is the first lane to actually need it; refining lint scope without a consumer file is paper-only.
- Vector-store lane then just *uses* the new boundary — no coordination dance.
- Same lane has both the rule and the example proving it works.

---

## 7 · Batching & caching

**Server-side batching:** the Modal function takes a `list[str]` and runs a single GPU forward pass. `embed_text` is implemented as a length-1 `embed_batch` under the hood — one code path on the server, two ergonomic shapes for callers.

**Client-side caching:** **none in v1.** A per-process LRU on `(text, instruction) → Embedding` is tempting but:
- Embeddings change with model_version updates; cache invalidation needs care.
- Cost is already low (§4); cache is a perf optimization, not a $$ optimization.
- The right cache layer is `vector_store` itself (lookup-by-content_hash) — duplicating that here is two sources of truth.

**Modal warm-pool / `keep_warm`:** none in v1. Cold-start ~12 s is acceptable for a primitive that runs as part of larger workflows. Re-evaluate via a follow-up (`EMBEDDING-WARM-POOL-1`) once we have p95 latency data.

---

## 8 · Cross-pinned contract with `vector-store-1`

The two lanes are paired *because* their schemas interact. The contract:

| Field            | Embedding service (producer)                          | Vector store (consumer)                                                            |
|------------------|-------------------------------------------------------|------------------------------------------------------------------------------------|
| `model_version`  | Emits literal `"bge-large-en-v1.5"`                    | Pydantic validator on upsert/query rejects any other literal (Q9)                  |
| `dimensions`     | Always 1024                                            | Postgres column is `vector(1024)`; mismatched length raises pre-DB                 |
| `normalized`     | Always `True` (BGE's `normalize_embeddings=True`)     | HNSW index uses cosine ops; `normalized=False` is rejected (cosine on un-normed vectors is wrong) |

Both lanes import the `ModelVersion` Literal and `DIMENSIONS` constant from a single source of truth (`lumo_ml/core/embeddings.py`). `vector_store.py` never restates `"bge-large-en-v1.5"` as a string — it imports `ModelVersion` so any change ripples through type-checking.

When the model rotates (e.g. `bge-large-en-v2.0` lands), the contract change is one edit (`Literal["bge-large-en-v1.5", "bge-large-en-v2.0"]`) plus a vector_store migration to add a `model_version` column constraint update. No mystery `"bge-large-en-v1.5"` strings hiding in random call sites.

---

## 9 · Open questions for reviewer

Each has a recommended default. Reviewer flips any they disagree with; implementation lane proceeds on the locked answers.

| #   | Question | Recommended default |
|-----|----------|---------------------|
| Q1  | New `apps/ml-service/lumo_ml/modal_bge.py` (separate Modal app) or fold into existing `modal_app.py`? | **New file** — mirrors `modal_clip.py` / `modal_whisper.py` precedent, independently deployable. |
| Q2  | GPU type: T4 default, A10G if p95 needs to drop. | **T4** — cost-optimal at v1 scale; revisit with real latency data. |
| Q3  | Batch ceiling: 32 vs 64 vs 128. | **64** — fits T4 memory headroom for 512-token inputs; batch=128 risks OOM on outlier inputs. |
| Q4  | Expose BGE retrieval-instruction prefix in v1? | **Yes** — costs nothing to expose; measurable retrieval quality lift; `instruction: str \| None` in request. |
| Q5  | Surface `tokens_consumed` from BGE's tokenizer in the response (vs. dropping it after `record_cost`)? | **Yes** — sibling field on response, not on `Embedding` itself; lets callers double-check the cost their span emitted. |
| Q6  | Sync wrappers around `embed_text` / `embed_batch`? | **No, async-only** — Modal RPC is intrinsically async; sync wrappers add deadlock foot-guns. |
| Q7  | Reject empty / whitespace-only input pre-Modal? | **Yes** — Pydantic `min_length=1` + a `@field_validator` on the batch shape. |
| Q8  | Lint-scope refinement (§6): same lane as embedding-service-1, or a separate `LINT-SCOPE-CORE-EXPAND-1` plumbing lane? | **Same lane** — refining lint without a consumer file is paper-only; vector-store-1 then just uses the new boundary. |
| Q9  | Vector-store rejects mismatched `model_version` via runtime `ValueError` or Pydantic validator? | **Pydantic validator** — fails at request-parse time; mirrors PYTHON-OBSERVABILITY-1 Layer-A discipline. |
| Q10 | Failed embed calls (Modal cold-start timeout, network drop) still emit `record_cost` for the GPU-seconds the failed attempt consumed? | **Yes** — `dollars_estimated=0` + `metadata={"status": "failed"}`. Failed inferences still cost compute; the dashboard should see them. |
| Q11 | Calibration of `DOLLARS_PER_M_TOKENS` over time. | **Module constant + filed `EMBEDDING-COST-CALIBRATION-SWEEP-1` quarterly recurring agent** to re-measure and PR the constant. |

---

## 10 · Implementation plan (subject to reviewer answers)

Once approved, single push lands:

1. **Lint-scope refinement** *(§6, Q8)*: edit `scripts/lint-traced-coverage.py` (`DEFAULT_TARGETS`, `SCOPE_FILE_EXCLUDES`); update `CONTRIBUTING.md` §1.1; add lint regression-test fixture for "`core/` non-infra requires `@traced`".
2. **`apps/ml-service/lumo_ml/core/embeddings.py`**: schemas (`Embedding`, `EmbedTextRequest`, `EmbedBatchRequest`, `EmbedTextResponse`, `EmbedBatchResponse`), `ModelVersion` Literal, `DIMENSIONS` constant, `DOLLARS_PER_M_TOKENS` constant, `embed_text` / `embed_batch` async functions wrapping Modal calls.
3. **`apps/ml-service/lumo_ml/modal_bge.py`** *(Q1)*: Modal `App`, T4 image, `embed_batch_remote` function, `lumo-bge-weights` Volume.
4. **`apps/ml-service/lumo_ml/core/__init__.py`**: re-export `Embedding`, `ModelVersion`, `DIMENSIONS`, `embed_text`, `embed_batch`.
5. **Pydantic codegen run** → `packages/lumo-shared-types/` regenerated; commit with the same lane.
6. **Tests** (`apps/ml-service/tests/test_embeddings.py`):
   - Schema contract: `model_version` Literal rejects unknown values; `dimensions` enforced both directions; `normalized=False` value rejected by vector-store-side validator (cross-tested in vector-store lane).
   - `record_cost` emission asserted via OTel test exporter.
   - Failed-call path emits `record_cost` with `metadata.status="failed"` *(Q10)*.
   - Latency-budget regression skipped if `MODAL_TOKEN_ID` unset (CI does not deploy).
7. **Gates:** `ruff` clean / `mypy` 0 issues / `pytest` green / `lint-traced-coverage.py` clean on the new file / `modal app list` compiles.

**Out of scope this lane:**
- Migration / `lumo_vectors` table — that's `PYTHON-VECTOR-STORE-1`.
- Production warm-pool sizing — `EMBEDDING-WARM-POOL-1` follow-up.
- Multi-lingual model — `EMBEDDING-MULTILINGUAL-ADD-1` follow-up if/when fired.

---

## 11 · Coordination + scope discipline

**In-scope this lane:**
- `apps/ml-service/lumo_ml/core/embeddings.py` (new)
- `apps/ml-service/lumo_ml/core/__init__.py` (re-export)
- `apps/ml-service/lumo_ml/modal_bge.py` (new)
- `apps/ml-service/scripts/lint-traced-coverage.py` (`DEFAULT_TARGETS`, `SCOPE_FILE_EXCLUDES`)
- `apps/ml-service/CONTRIBUTING.md` §1.1 (lint-scope policy update)
- `apps/ml-service/docs/designs/embedding-service.md` (this file)
- `apps/ml-service/tests/test_embeddings.py` (new)
- `apps/ml-service/tests/fixtures/traced_lint/core_requires_traced.py` (new lint regression fixture)
- `packages/lumo-shared-types/**` (codegen output)

**Out-of-scope cross-lane coordination:**
- `apps/web/**` — codex's lane; record_cost flows through OTel events that codex's plan-client logger already consumes (PYTHON-OBSERVABILITY-1 wired this).
- `apps/ios/**` — claude-code's lane; not in dependency path.
- `db/migrations/**` — `PYTHON-VECTOR-STORE-1` adds migration 060.

**Filed follow-ups (post-approval queue):**
- `EMBEDDING-COST-CALIBRATION-SWEEP-1` — quarterly recurring agent to re-measure `DOLLARS_PER_M_TOKENS` against current Modal pricing + actual throughput on canonical fixtures.
- `EMBEDDING-WARM-POOL-1` — re-evaluate Modal `keep_warm` once production p95 latency data exists.
- `EMBEDDING-MULTILINGUAL-ADD-1` — only if a real use case fires; v1 stays single-model.

---

## 12 · What I'm waiting on before scope work

1. Reviewer approval on the 11 open questions in §9 (or counter-recommendations).
2. Confirmation that lint-scope refinement (§6, Q8) belongs in this lane vs. its own.
3. Implicit: `OBSERVABILITY-LINT-COVERAGE-1` lands on `origin/main` first, so the lint script we're refining is the version this lane rebases over. (Brief assumes this is sequenced; flagging in case sequencing slips.)
