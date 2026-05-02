# Vector store — design

**Lane:** `PYTHON-VECTOR-STORE-1`
**Branch:** `claude-code-python/python-vector-store-1`
**Stacked on:** `origin/main` (post `OBSERVABILITY-LINT-COVERAGE-1` merge)
**Paired with:** [`embedding-service.md`](./embedding-service.md) — `PYTHON-EMBEDDING-SERVICE-1`
**Status:** design-only commit. Stop here for reviewer approval before any migration or storage code lands.

---

## TL;DR for the reviewer

A general-purpose vector storage primitive at `apps/ml-service/lumo_ml/core/vector_store.py`. Postgres + pgvector backend (extension already in use across migrations 015 / 020 / 032 / 035 / 036). New `lumo_vectors` table under migration 060: `vector(1024)` matching BGE-large-en-v1.5, HNSW `m=16 / ef_construction=64` mirroring the sealed ADR-011 §4 parameters from `unified_embeddings`. Public surface — `upsert`, `query`, `delete`, `count` — each `@traced`; `record_cost` on the query path attaches HNSW-vs-seqscan + result-set-size telemetry.

The contract from the paired lane (`PYTHON-EMBEDDING-SERVICE-1`) is enforced at the schema layer: `VectorRecord.model_version` and `QueryRequest.embedding.model_version` are `Literal["bge-large-en-v1.5"]` *imported from* `lumo_ml/core/embeddings.py`, not restated as strings. A vector with a `model_version` the consumer doesn't recognize fails at request-parse time, not at SQL time. Dimensions (1024) and normalization (True) are equally contract-locked.

**Why a new table, not `unified_embeddings`:** unified_embeddings is MMRAG-1's modality-projector substrate with cascade triggers from `content_embeddings` / `image_embeddings` / `audio_transcripts` / `pdf_documents`. `lumo_vectors` is a caller-supplied general-purpose store — different ownership, different lifecycle, different deletion semantics. Same dimensionality + same HNSW parameters; semantically different. §3 covers the call.

13 open questions in §9 — all have a recommended default. Reviewer answers lock them in. Implementation lands as a single push once approved.

---

## 1 · Backend: Postgres + pgvector

**Locked by precedent.** pgvector is already an extension in this database — migrations 015 (`content_embeddings vector(384)`), 020 (`image_embeddings`), 032 (`unified_embeddings vector(1024)`), 035 (KG embedding seed RPC), 036 (auth-hardening) all `create extension if not exists vector`. We add a fifth consumer, not a new dependency.

**Alternatives considered + declined:**

| Option | Verdict |
|---|---|
| Pinecone / Weaviate (external managed) | Net-new vendor, net-new auth surface, net-new outage axis, no observability story today. Off the table for v1. |
| Modal Volume + faiss | Storage in a Modal Volume couples vector lifecycle to Modal container lifecycle; backups, RLS, and replication are reinvented. Off the table. |
| Qdrant self-hosted | Operational burden vs. zero added burden of pgvector. Declined unless we hit a real pgvector ceiling. |
| Reuse `unified_embeddings` directly | See §3 — semantically wrong. |

---

## 2 · Migration 060 — `lumo_vectors` table

```sql
-- Migration 060 — PYTHON-VECTOR-STORE-1: general-purpose caller-supplied vector store.
--
-- Companion to apps/ml-service/lumo_ml/core/vector_store.py and the paired
-- BGE-large-en-v1.5 producer in lumo_ml/core/embeddings.py. Single-model at
-- v1: every row's model_version column == 'bge-large-en-v1.5'. The check
-- constraint is enumerated (not a regex) so adding a new model is an
-- explicit migration, not a typo away.
--
-- NOT unified_embeddings (migration 032). unified_embeddings is MMRAG-1's
-- modality-projector substrate, cascade-deleted from native source tables.
-- lumo_vectors is caller-supplied: the caller owns content_hash, namespace,
-- and metadata; deletion is explicit, not triggered.
--
-- HNSW parameters (m=16, ef_construction=64) mirror the sealed ADR-011 §4
-- decision used by unified_embeddings. Same parameter sweep applies if
-- recall@5 / latency drift; rebuild cron lands under a future
-- VECTOR-STORE-INDEX-MAINT-1 follow-up.
--
-- Rollback:
--   drop function if exists public.lumo_vectors_query(uuid, vector, integer, jsonb);
--   drop index    if exists public.lumo_vectors_namespace;
--   drop index    if exists public.lumo_vectors_content_hash;
--   drop index    if exists public.lumo_vectors_hnsw;
--   drop table    if exists public.lumo_vectors;

create extension if not exists vector;

create table if not exists public.lumo_vectors (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  namespace       text not null,                                        -- caller-supplied partition key (e.g. 'plan-history', 'docs', 'memories')
  external_id     text,                                                 -- caller's stable handle for upsert idempotency
  content_hash    text not null,                                        -- sha256 of source text; lookup-by-hash dedupe
  text            text not null,                                        -- redacted; PII gates upstream
  metadata        jsonb not null default '{}'::jsonb,
  embedding       vector(1024) not null,
  model_version   text not null check (model_version in ('bge-large-en-v1.5')),
  normalized      boolean not null default true check (normalized = true),  -- HNSW cosine_ops requires normed vectors
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, namespace, external_id)                              -- partial-NULL: external_id NULL allows raw inserts
);

create index if not exists lumo_vectors_namespace
  on public.lumo_vectors (user_id, namespace, created_at desc);

create index if not exists lumo_vectors_content_hash
  on public.lumo_vectors (user_id, content_hash);

-- HNSW (ADR-011 §4 sealed parameters; same as unified_embeddings).
create index if not exists lumo_vectors_hnsw
  on public.lumo_vectors using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create trigger lumo_vectors_touch_updated_at
  before update on public.lumo_vectors
  for each row execute function public.touch_updated_at();

alter table public.lumo_vectors enable row level security;
revoke all on public.lumo_vectors from anon, authenticated;
grant all on public.lumo_vectors to service_role;

-- Server-side similarity query (RLS-respecting; service_role only).
-- The Python client calls this RPC instead of issuing raw pgvector SQL so
-- the index-vs-seqscan choice and the cosine threshold live in one place.
create or replace function public.lumo_vectors_query(
  p_user_id   uuid,
  p_query     vector(1024),
  p_top_k     integer,
  p_filter    jsonb
) returns table (
  id            uuid,
  namespace     text,
  external_id   text,
  text          text,
  metadata      jsonb,
  score         real,
  model_version text
)
language sql
stable
as $$
  select v.id, v.namespace, v.external_id, v.text, v.metadata,
         (1.0 - (v.embedding <=> p_query))::real as score,
         v.model_version
    from public.lumo_vectors v
   where v.user_id = p_user_id
     and (p_filter ? 'namespace' is not true
          or v.namespace = (p_filter->>'namespace'))
   order by v.embedding <=> p_query
   limit greatest(1, least(p_top_k, 100));
$$;
```

**Notes on the schema:**

- `model_version text` with an enumerated `check` constraint, not the Pydantic Literal — Postgres has no native Literal type, but the `check (model_version in ('bge-large-en-v1.5'))` enforcement gives the same property at the DB level. Adding a model is an explicit migration ALTER. Q3.
- `normalized boolean ... check (normalized = true)` looks redundant but documents the assumption — the HNSW cosine_ops index returns wrong results if un-normalized vectors slip in. The check is cheap insurance.
- `external_id` is nullable so raw inserts (no caller-side idempotency key) still work; `unique (user_id, namespace, external_id)` becomes a partial constraint for non-null `external_id`. Q5 covers whether to require it.
- `lumo_vectors_query` RPC keeps the cosine-distance expression, the result-tuple shape, and the LIMIT cap (max 100) on the server. Python client is a thin wrapper. Q7.

**Why migration 060:** last applied is 059 (PYTHON-OBSERVABILITY-1's `agent_cost_records`). No in-flight migrations from codex per STATUS.md.

---

## 3 · Why `lumo_vectors`, not `unified_embeddings`

unified_embeddings (migration 032) and lumo_vectors look superficially identical (both `vector(1024)`, both HNSW with the same parameters). They're not the same primitive.

| Axis | `unified_embeddings` | `lumo_vectors` |
|---|---|---|
| Ownership | Owned by MMRAG-1 (codex). Rows materialized from native source tables via projectors. | Owned by Python lanes. Rows are caller-supplied. |
| Population | Cascaded from `content_embeddings` / `image_embeddings` / `audio_transcripts` / `pdf_documents` via the cascade-delete trigger family. | Direct `upsert` from caller. |
| Deletion | Cascade triggers — when a native row dies, the unified row dies with it. | Explicit `delete(record_id)` from caller; survives until caller removes it. |
| Schema fields | `modality`, `source_table`, `source_row_id`, `projector_version`, `text_repr`. | `namespace`, `external_id`, `content_hash`, `text`, `metadata`. |
| Embedding source | Linear projector from native model output (CLIP, audio, text) into 1024-d unified space. | Direct from `embeddings.py` (BGE-large-en-v1.5). Same 1024-d, no projection. |
| Read path | `lumo_recall_unified` RPC (joins across source tables, runs cross-encoder re-ranker). | `lumo_vectors_query` RPC (single-table, no re-ranker). |
| Cardinality | High — every native row has a matching unified row. | Caller-driven. |

Trying to fold `lumo_vectors` into `unified_embeddings` would mean inventing a `modality='generic'` + a no-op projector + a phantom `source_table='caller_supplied'` — three lies to satisfy a constraint. Cleaner: separate table, same dimensionality, same HNSW parameters. The two tables can be UNION'd at query time if a future workflow ever needs cross-substrate recall (`VECTOR-STORE-UNIFIED-RECALL-1` follow-up).

---

## 4 · Index strategy: HNSW `m=16 / ef_construction=64`

**Mirroring** `unified_embeddings` (ADR-011 §4, sealed). Same parameter set means:
- Same recall@5 / latency profile, modulo `lumo_vectors`'s smaller-table baseline.
- Same parameter-sweep playbook (migration 034 in the unified_embeddings family) applies if drift shows up.
- Same quarterly-rebuild cadence; filed as `VECTOR-STORE-INDEX-MAINT-1` follow-up.

**Distance metric: cosine** (`vector_cosine_ops`). BGE-large emits L2-normalized vectors → cosine ≡ dot product → HNSW search is the fastest of the three operator families pgvector ships. The `normalized = true` constraint guarantees the index assumption holds.

**Probe-time `hnsw.ef_search`:** default = 40 (pgvector default). Q9.

---

## 5 · Public surface (Pydantic + functions)

```python
# apps/ml-service/lumo_ml/core/vector_store.py
from typing import Annotated, Any
from pydantic import BaseModel, Field, field_validator
from lumo_ml.core import Secret, traced, record_cost
from lumo_ml.core.embeddings import Embedding, ModelVersion, DIMENSIONS


class VectorRecord(BaseModel):
    user_id: str                                                    # opaque id, not Secret
    namespace: str = Field(..., min_length=1, max_length=64)
    external_id: str | None = Field(None, max_length=128)
    content_hash: str = Field(..., min_length=64, max_length=64)    # sha256 hex
    text: Annotated[str, Secret] = Field(..., min_length=1, max_length=8192)
    metadata: dict[str, Any] = Field(default_factory=dict)
    embedding: Embedding


class QueryRequest(BaseModel):
    user_id: str
    embedding: Embedding
    top_k: int = Field(default=10, ge=1, le=100)
    namespace: str | None = None                                    # filter (Q6)


class VectorMatch(BaseModel):
    id: str
    namespace: str
    external_id: str | None
    text: Annotated[str, Secret]
    metadata: dict[str, Any]
    score: float                                                    # cosine similarity ∈ [0, 1]
    model_version: ModelVersion


class QueryResponse(BaseModel):
    matches: list[VectorMatch]


class UpsertResponse(BaseModel):
    id: str
    inserted: bool                                                  # False = updated existing


class CountFilter(BaseModel):
    user_id: str
    namespace: str | None = None


@traced("vector_store.upsert")
async def upsert(record: VectorRecord) -> UpsertResponse: ...


@traced("vector_store.query")
async def query(req: QueryRequest) -> QueryResponse: ...


@traced("vector_store.delete")
async def delete(record_id: str, *, user_id: str) -> bool: ...


@traced("vector_store.count")
async def count(filter: CountFilter) -> int: ...
```

**Why import `Embedding` / `ModelVersion` / `DIMENSIONS` from `embeddings.py` rather than restating:** the cross-pinned contract (§6 below) is whatever the producer says it is. A second source of truth is a divergence waiting to happen.

**Why `VectorMatch.text` is `Annotated[str, Secret]`:** queries return user-derived text. Layer-A redaction discipline applies on the way out as much as on the way in.

**Why `text` is a `str` field on the record (not optional):** retrieval workflows almost always need the source text alongside the score. Storing a separate text-fetch round-trip is two queries where one suffices. If a caller wants embedding-only storage they pass an empty string — the `min_length=1` on the field is a deliberate forcing function (Q4).

---

## 6 · Cross-pinned contract with `embedding-service-1`

The two lanes share three contract values, all imported from `lumo_ml/core/embeddings.py`:

| Value           | Source of truth          | Vector-store enforcement                                   |
|-----------------|--------------------------|------------------------------------------------------------|
| `ModelVersion`  | `Literal["bge-large-en-v1.5"]` in `embeddings.py` | Pydantic narrows at request-parse (any other literal raises ValidationError) |
| `DIMENSIONS`    | `1024` constant in `embeddings.py` | `vector(1024)` column shape; pgvector raises on length mismatch pre-DB |
| `normalized`    | `True` (BGE always normalizes)   | `check (normalized = true)` Postgres constraint + HNSW cosine_ops index correctness |

When `embedding-service` rotates the model (e.g. `bge-large-en-v2.0` lands), the change is:

1. `embeddings.py` updates `ModelVersion = Literal["bge-large-en-v1.5", "bge-large-en-v2.0"]`.
2. A new migration (`061_lumo_vectors_v2_model.sql`) widens the check constraint to `('bge-large-en-v1.5', 'bge-large-en-v2.0')`.
3. Vector-store reads pick up automatically (Pydantic Literal widens; the column already accepts the new value).

No mystery `"bge-large-en-v1.5"` strings hiding in random call sites. The Python type system catches a missed update; the Postgres check catches a missed migration.

---

## 7 · @traced surface + lint-scope alignment

Every public function in `lumo_ml/core/vector_store.py` is `@traced`:

| Function | `@traced` operation        |
|----------|----------------------------|
| `upsert` | `vector_store.upsert`      |
| `query`  | `vector_store.query`       |
| `delete` | `vector_store.delete`      |
| `count`  | `vector_store.count`       |

**Lint-scope assumption:** this lane assumes `PYTHON-EMBEDDING-SERVICE-1` (Q8 in that lane's design) ships the lint-scope refinement that widens `DEFAULT_TARGETS` to include `lumo_ml/core/` and exempts only the named tracing-infra files. Under that refinement, `lumo_ml/core/vector_store.py` is automatically in scope — this lane just adds new code that satisfies the rule.

**If embedding-service-1 doesn't ship the refinement** (reviewer flips Q8 to "separate plumbing lane"): this lane adds the lint-scope refinement instead. Same diff, different lane label. Doesn't change the design — only the commit topology.

---

## 8 · Cost telemetry — query cost is real

Vector-store doesn't burn GPU and doesn't tokenize, but `query` cost on a multi-million-row HNSW index is a real budget line.

`record_cost` payload per `query` call:

```python
record_cost(
    "vector_store.query",
    embedding_ops=0,
    gpu_seconds=0.0,
    dollars_estimated=0.0,                     # negligible at v1 scale; revisit on growth
    metadata={
        "top_k": req.top_k,
        "matches_returned": len(matches),
        "filter_namespace": req.namespace or "<none>",
        "p99_latency_bucket": _latency_bucket(elapsed),  # 0-10ms / 10-50 / 50-200 / 200+
    },
)
```

`upsert` and `delete` emit `record_cost` too — their `dollars_estimated=0.0` but the operation count is what makes "where did our DB compute go?" answerable in dashboards.

**Why `dollars_estimated=0.0` and not a populated value:** at v1 scale, query cost on a single-table HNSW lookup is dominated by Supabase compute, not per-query. Once the table grows or the workload shifts, a follow-up (`VECTOR-STORE-COST-CALIBRATION-1`) measures the per-query compute and updates `dollars_estimated`.

---

## 9 · Open questions for reviewer

| #   | Question | Recommended default |
|-----|----------|---------------------|
| Q1  | Table name `lumo_vectors` vs more-specific (`lumo_text_vectors`, `bge_large_vectors`)? | **`lumo_vectors`** — single-model today but the primitive is the storage shape, not the model. Multi-model is a check-constraint widening. |
| Q2  | RLS: service_role only vs. user-scoped read for end-user features? | **service_role only** — Python lanes call from server side; user-facing reads are codex's web layer's call (separate decision when fired). |
| Q3  | `model_version` enforcement at DB layer: enumerated check constraint (recommended) vs FK to a `lumo_model_versions` lookup table? | **Enumerated check** — single column, no JOIN, ALTER on widening is one migration. Lookup table is overkill until 4+ versions live. |
| Q4  | Require `text` non-empty (recommended) vs allow embedding-only storage? | **Require non-empty** — retrieval workflows almost always need source text; embedding-only storage hides a bug class. Caller can always pass a `text="<encoded:opaque>"` placeholder. |
| Q5  | Require `external_id` (caller-supplied idempotency key) on every upsert vs allow NULL? | **Allow NULL** — partial unique constraint on `(user_id, namespace, external_id)` means raw inserts work; idempotent callers get dedupe. |
| Q6  | `QueryRequest.namespace` filter — single-namespace (recommended) vs `list[str]` multi-namespace OR? | **Single namespace v1** — multi-namespace is a `WHERE namespace = ANY ($1)` follow-up if a use case fires. |
| Q7  | Server-side RPC (`lumo_vectors_query`) vs Python-side raw pgvector SQL via supabase-py? | **Server-side RPC** — distance expression + LIMIT cap + RLS check live in one place; Python client is thin. |
| Q8  | Probe-time `hnsw.ef_search`: pgvector default (40) vs higher (e.g. 100) for better recall? | **Default 40 v1** — measured recall@10 on canonical fixtures decides the bump in a follow-up (`VECTOR-STORE-EF-SEARCH-TUNE-1`). |
| Q9  | `query` returns `score = 1 - cosine_distance` (similarity, ∈ [0,1] for normed vectors). Same shape as elsewhere? | **Yes** — `unified_embeddings` ad-hoc queries don't normalize the return shape; we set the precedent here. Higher = more similar. |
| Q10 | Hard cap on `top_k` server-side? | **100** — matches `LIMIT greatest(1, least(p_top_k, 100))` in the RPC. Higher caps invite cost surprises; raise via follow-up if a caller proves the need. |
| Q11 | Soft-delete (`deleted_at`) vs hard `delete`? | **Hard delete v1** — soft-delete adds a `WHERE deleted_at is null` to every read for benefit nobody's asked for. Re-evaluate on first compliance ask. |
| Q12 | `count` API necessary in v1 vs ship without it? | **Ship it** — it's 5 lines of code; absence guarantees somebody writes a `query(top_k=10000)` workaround that destroys budget. |
| Q13 | Cross-stack consumer: does codex's web layer need a TS-side client wrapper (`packages/lumo-shared-types/` will get the codegen anyway), or is calling the Python `/vector_store` HTTP endpoint enough? | **Codegen-only v1** — codex pulls the TS types via the existing pydantic-to-typescript pipeline; HTTP endpoint shape is the contract. Wrapper lib is a TS-side decision (not this lane). |

---

## 10 · Implementation plan (subject to reviewer answers)

Once approved, single push lands:

1. **Migration 060** (`db/migrations/060_lumo_vectors.sql`): table, indexes, RLS, `lumo_vectors_query` RPC, rollback comment block. Per CLAUDE.md doctrine, coordinate via STATUS.md if codex has a migration in flight (no conflict at brief time per active table).
2. **`apps/ml-service/lumo_ml/core/vector_store.py`**: schemas (`VectorRecord`, `QueryRequest`, `VectorMatch`, `QueryResponse`, `UpsertResponse`, `CountFilter`), `upsert` / `query` / `delete` / `count` async functions wrapping a shared `_supabase_client` accessor.
3. **`apps/ml-service/lumo_ml/core/__init__.py`**: re-export `VectorRecord`, `QueryRequest`, `VectorMatch`, `upsert`, `query`, `delete`, `count`.
4. **Pydantic codegen run** → `packages/lumo-shared-types/` regenerated; commit with the same lane.
5. **Lint-scope refinement (only if not already shipped by embedding-service-1, per §7):** widen `DEFAULT_TARGETS` to `("lumo_ml/plan", "lumo_ml/core")`; add tracing-infra files to `SCOPE_FILE_EXCLUDES`.
6. **Tests** (`apps/ml-service/tests/test_vector_store.py`):
   - Schema contract: `model_version` Literal rejects unknown values; `dimensions` mismatch on `Embedding.values` rejected; `normalized=False` rejected.
   - End-to-end upsert → query → delete against a Supabase test schema (skip if `LUMO_TEST_SUPABASE_URL` unset).
   - `query` returns `score ∈ [0, 1]` for normed inputs; descending order.
   - `top_k` cap enforced server-side (RPC LIMIT honored).
   - `record_cost` emission on each public function (OTel test exporter).
   - Migration round-trip: rollback + replay leaves the table unchanged.
7. **Gates:** `ruff` clean / `mypy` 0 issues / `pytest` green / `lint-traced-coverage.py` clean on the new file / migration runs cleanly against a fresh Supabase test DB.

**Out of scope this lane:**
- BGE model serving — that's `PYTHON-EMBEDDING-SERVICE-1`.
- Cross-substrate UNION recall with `unified_embeddings` — `VECTOR-STORE-UNIFIED-RECALL-1` follow-up.
- HNSW index maintenance / quarterly rebuild — `VECTOR-STORE-INDEX-MAINT-1` follow-up.
- Probe-time `ef_search` tuning — `VECTOR-STORE-EF-SEARCH-TUNE-1` follow-up.
- Per-query dollar calibration — `VECTOR-STORE-COST-CALIBRATION-1` follow-up.

---

## 11 · Coordination + scope discipline

**In-scope this lane:**
- `db/migrations/060_lumo_vectors.sql` (new)
- `apps/ml-service/lumo_ml/core/vector_store.py` (new)
- `apps/ml-service/lumo_ml/core/__init__.py` (re-export)
- `apps/ml-service/docs/designs/vector-store.md` (this file)
- `apps/ml-service/tests/test_vector_store.py` (new)
- `packages/lumo-shared-types/**` (codegen output)
- *(Conditional, only if embedding-service-1 didn't ship it)*: `scripts/lint-traced-coverage.py` + `CONTRIBUTING.md` §1.1.

**Cross-lane coordination via STATUS.md:**
- Migration 060 is the next number after PYTHON-OBSERVABILITY-1's 059. Active table at brief time shows no migrations in flight from codex; if one lands while this lane is open, rebase additively and bump to 061+.
- The cross-pinned `ModelVersion` Literal is imported, not restated. If `PYTHON-EMBEDDING-SERVICE-1`'s implementation changes the literal value before this lane lands, type-checking catches it.

**Out-of-scope cross-lane coordination:**
- `apps/web/**` — codex's lane. The cross-stack TS-side client (if/when needed) is a TS-side decision (Q13).
- `apps/ios/**` — claude-code's lane; not in dependency path.

**Filed follow-ups (post-approval queue):**
- `VECTOR-STORE-INDEX-MAINT-1` — quarterly HNSW rebuild cron (mirrors ADR-011 §14 risk register cadence for `unified_embeddings`).
- `VECTOR-STORE-EF-SEARCH-TUNE-1` — measure recall@10 vs `ef_search` on canonical fixtures; bump default if warranted.
- `VECTOR-STORE-COST-CALIBRATION-1` — measure per-query compute once table grows past 100k rows; populate `dollars_estimated`.
- `VECTOR-STORE-UNIFIED-RECALL-1` — UNION query path across `lumo_vectors` and `unified_embeddings` if a workflow requires cross-substrate recall.

---

## 12 · What I'm waiting on before scope work

1. Reviewer approval on the 13 open questions in §9 (or counter-recommendations).
2. Confirmation on whether the lint-scope refinement ships under embedding-service-1 (Q8 of that doc) or under this lane (§7 above).
3. Implicit: `PYTHON-EMBEDDING-SERVICE-1` lands the `ModelVersion` / `DIMENSIONS` / `Embedding` source of truth that this lane imports. Implementation order: embedding-service-1 first, vector-store-1 second. Design phase paired; implementation serial.
4. Implicit: `OBSERVABILITY-LINT-COVERAGE-1` lands on `origin/main` so the lint script being refined is the version this lane rebases over.
