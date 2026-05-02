# Vector store — design (revised per fire brief)

**Lane:** `PYTHON-VECTOR-STORE-1`
**Branch:** `claude-code-python/python-vector-store-1`
**Stacked on:** paired with `PYTHON-EMBEDDING-SERVICE-1`; implementation rebases past that lane + `OBSERVABILITY-LINT-COVERAGE-1` (both must land on `origin/main` first).
**Priority:** P1 platform foundation
**Paired with:** [`embedding-service.md`](./embedding-service.md) — `PYTHON-EMBEDDING-SERVICE-1`
**Status:** design-only commit. Stop here for reviewer approval before any migration or storage code lands.

> **Revision note:** the previous version of this doc (commit `c60e0e6`) was written before the formal fire brief landed. This version supersedes it. Material changes from v1: drop the `text` column from the row schema, drop `namespace` / `external_id` / `content_hash` in favor of `(collection, source_id, source_type)`, change the public API so `vector_store` calls `embedding-service.embed()` internally instead of accepting `Embedding` objects, switch RLS from service-role-only to user-scoped, add the per-collection index-tier strategy, and add the model_version reindexing playbook. Cross-pin contract with `embedding-service-1` is unchanged.

---

## TL;DR for the reviewer

A single vector-store interface used by memory, retrieval, and recommendations. Backend: Postgres + pgvector via Supabase (zero new infra, transactional joins with relational data, RLS just works). Qdrant on Modal Volume is the documented escape hatch for collections that exceed pgvector's comfortable ceiling (>10M vectors, or hot collections where p95 latency degrades) — file as a follow-up; not v1.

Migration 060 lands the `lumo_embeddings` table with the brief's schema — `(id, collection, vector, model_version, source_id, source_type, user_id, created_at, metadata jsonb)` — explicitly **without** a `text` column. The vector store is a vector index, not a content store; callers dereference `(source_type, source_id)` to fetch source text from the canonical originating table. This decouples embedding lifecycle from content lifecycle and avoids storing user text twice.

Public surface — `vector_store.upsert(collection, source_id, source_type, text, metadata)` and `vector_store.search(collection, query, top_k, filter)` — accepts raw text and internally calls `embedding-service.embed_text` / `embed_batch`. Callers don't construct `Embedding` objects; they hand over text. The `model_version` is stamped from whatever `embedding-service` emits, then validated against the column's enumerated check constraint.

Index strategy is tiered per collection (per fire brief): no index for <1k rows, HNSW for hot <100k, ivfflat for >1k cold. v1 implementation question: ship single-table HNSW only and file tiering as `VECTOR-STORE-INDEX-TIERING-1`, or ship Postgres declarative partitioning with per-partition indexes from day one. **Recommended default:** ship single-table HNSW v1; tiering as a Phase-2 follow-up — partitioning at v1 is complexity ahead of measured need (Q5 in §11).

RLS is user-scoped via `auth.uid() = user_id` (per fire brief's "users only see their own embeddings unless explicitly shared"). Sharing mechanism is deferred to a follow-up; v1 has only owner-read.

Reindexing on `model_version` change follows the brief's three-phase playbook: dual-write window → lazy backfill on touch → drop old vectors. §8 lays it out.

13 open questions in §11 — all have a recommended default. Reviewer answers lock them in. Single-push implementation follows once approved.

---

## 1 · Backend choice — pgvector primary, Qdrant fallback

**Locked by fire brief.** Documenting the why so it's auditable.

| Backend | Verdict | Reason |
|---|---|---|
| **pgvector (Supabase Postgres)** | **v1 primary** | Already an extension on this DB (5th consumer; migrations 015, 020, 032, 035, 036). Zero new infra, transactional joins with relational data, Supabase RLS works out of the box, Postgres-native backups + replication + observability. |
| **Qdrant on Modal Volume** | **v1 documented escape hatch; not implemented** | Better p99 query latency on multi-million-vector collections; richer filter expression language; HNSW with on-disk variants. Costs: net-new infra, snapshot-vs-live tradeoff for Modal Volume durability, no transactional joins. File as `VECTOR-STORE-QDRANT-FALLBACK-1` with the trigger documented (see Q3). |
| LanceDB | Declined | Embedded format is a fit for Modal-side analytics workflows; the vector_store primitive is shared infrastructure called from FastAPI request handlers — embedded storage doesn't fit the deployment topology. |
| Pinecone / Weaviate (managed) | Declined | Net-new vendor, net-new auth surface, net-new outage axis, no observability story today. |

**Backend abstraction in code:** the `vector_store` module exposes a backend-agnostic public surface; `_PgVectorBackend` is the only concrete implementation in v1. When Qdrant lands, `_QdrantBackend` slots in behind a feature flag (`LUMO_VECTOR_STORE_BACKEND=pgvector|qdrant` env var) per-collection. Callers don't change.

**Migration trigger to Qdrant (documented; not in v1 code):** when any single collection crosses 10M rows OR p95 search latency on a single collection exceeds 250ms despite HNSW + ef_search tuning. The trigger threshold is filed alongside the follow-up so we have a measurable escalation gate.

---

## 2 · Migration 060 — `lumo_embeddings` table

The schema is what the fire brief specifies. Annotations explain the choices.

```sql
-- Migration 060 — PYTHON-VECTOR-STORE-1: pgvector-backed shared vector store.
--
-- Companion to apps/ml-service/lumo_ml/core/vector_store.py and the paired
-- BGE-large-en-v1.5 producer in lumo_ml/core/embeddings.py. Single-model at
-- v1: every row's model_version column == 'bge-large-en-v1.5'. The check
-- constraint is enumerated (not a regex) so adding a new model is an
-- explicit migration, not a typo away.
--
-- NOT unified_embeddings (migration 032). unified_embeddings is MMRAG-1's
-- modality-projector substrate, cascade-deleted from native source tables.
-- lumo_embeddings is caller-supplied: callers own (source_type, source_id),
-- callers fetch source text from the originating table on read, callers
-- delete embeddings explicitly via vector_store.delete().
--
-- HNSW parameters (m=16, ef_construction=64) mirror the sealed ADR-011 §4
-- decision used by unified_embeddings. Same parameter sweep applies if
-- recall@5 / latency drift; rebuild cron lands under a future
-- VECTOR-STORE-INDEX-MAINT-1 follow-up.
--
-- v1 ships a single table-level HNSW index. The fire brief's per-collection
-- tier strategy (no index <1k / HNSW <100k hot / ivfflat >1k cold) is
-- documented in apps/ml-service/docs/designs/vector-store.md §5 and filed
-- as VECTOR-STORE-INDEX-TIERING-1 to land via Postgres declarative
-- partitioning once measured need exists. See Q5 in the design doc.
--
-- Rollback:
--   drop function if exists public.lumo_embeddings_search(uuid, text, vector, integer, jsonb);
--   drop policy   if exists lumo_embeddings_owner_select on public.lumo_embeddings;
--   drop policy   if exists lumo_embeddings_owner_modify on public.lumo_embeddings;
--   drop index    if exists public.lumo_embeddings_collection;
--   drop index    if exists public.lumo_embeddings_source;
--   drop index    if exists public.lumo_embeddings_hnsw;
--   drop table    if exists public.lumo_embeddings;

create extension if not exists vector;

create table if not exists public.lumo_embeddings (
  id              uuid        primary key default gen_random_uuid(),
  collection      text        not null check (collection ~ '^[a-z][a-z0-9_]{1,63}$'),
  vector          vector(1024) not null,
  model_version   text        not null check (model_version in ('bge-large-en-v1.5')),
  source_id       text        not null,                              -- caller's stable handle (e.g. messages.id, docs.id)
  source_type     text        not null check (source_type ~ '^[a-z][a-z0-9_]{1,63}$'),  -- caller's row-shape namespace (e.g. 'message', 'doc_chunk')
  user_id         uuid        not null references public.profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  metadata        jsonb       not null default '{}'::jsonb,
  unique (user_id, collection, source_type, source_id)               -- caller-driven idempotency: re-upsert same source = update vector + metadata
);

-- Lookup-by-collection (the dominant filter on read).
create index if not exists lumo_embeddings_collection
  on public.lumo_embeddings (user_id, collection, created_at desc);

-- Lookup-by-source (orphan-detection sweep + caller-driven cascade delete).
create index if not exists lumo_embeddings_source
  on public.lumo_embeddings (source_type, source_id);

-- HNSW table-level (v1; per-collection tiering is the VECTOR-STORE-INDEX-
-- TIERING-1 follow-up). m=16, ef_construction=64 — ADR-011 §4 sealed.
create index if not exists lumo_embeddings_hnsw
  on public.lumo_embeddings using hnsw (vector vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ── RLS: user-scoped owner read + owner write ─────────────────────────
alter table public.lumo_embeddings enable row level security;

revoke all on public.lumo_embeddings from anon;
grant  select, insert, update, delete on public.lumo_embeddings to authenticated;
grant  all on public.lumo_embeddings to service_role;

create policy lumo_embeddings_owner_select
  on public.lumo_embeddings for select
  to authenticated
  using (auth.uid() = user_id);

create policy lumo_embeddings_owner_modify
  on public.lumo_embeddings for all
  to authenticated
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Server-side similarity search RPC ─────────────────────────────────
-- The Python client calls this RPC instead of issuing raw pgvector SQL so
-- the cosine expression, the LIMIT cap, and the RLS check live in one
-- place. Callable as either authenticated (RLS auto-applies) or
-- service_role (caller-supplied user_id is enforced inside).
create or replace function public.lumo_embeddings_search(
  p_user_id    uuid,
  p_collection text,
  p_query      vector(1024),
  p_top_k      integer,
  p_filter     jsonb
) returns table (
  id            uuid,
  source_type   text,
  source_id     text,
  metadata      jsonb,
  score         real,
  model_version text,
  created_at    timestamptz
)
language sql
stable
security invoker                                           -- RLS applies for authenticated callers
as $$
  select v.id, v.source_type, v.source_id, v.metadata,
         (1.0 - (v.vector <=> p_query))::real as score,
         v.model_version, v.created_at
    from public.lumo_embeddings v
   where v.user_id = p_user_id
     and v.collection = p_collection
     and (p_filter ? 'source_type' is not true
          or v.source_type = (p_filter->>'source_type'))
   order by v.vector <=> p_query
   limit greatest(1, least(p_top_k, 100));
$$;
```

**Notes on the schema:**

- **No `text` column** — fire brief's call. The vector store is a pure vector index. The originating row in `messages` / `documents` / `memories` / etc. is the source of truth for content; callers dereference `(source_type, source_id)` after reading search results. Saves duplicated user-text storage and decouples embedding lifecycle from content lifecycle.
- `collection` is a regex-constrained text field — `^[a-z][a-z0-9_]{1,63}$` matches Postgres identifier conventions and prevents accidental SQL-y characters in caller-supplied collection names.
- `source_type` is similarly regex-constrained — both are caller-supplied namespaces and we want them tightly scoped.
- `unique (user_id, collection, source_type, source_id)` makes upserts idempotent: re-upserting the same `(collection, source_type, source_id)` for a user updates the existing vector + metadata (single-row update) instead of duplicating.
- `model_version` is `text` with an enumerated check constraint, not the Pydantic Literal — Postgres has no Literal type, but `check (model_version in ('bge-large-en-v1.5'))` gives the same property at the DB level. Adding a model is an explicit migration ALTER (`061_lumo_embeddings_v2_model.sql` widens the check). Q6.
- `lumo_embeddings_search` runs `security invoker` so RLS policies apply for authenticated callers; service_role calls it with an explicit `p_user_id` (bypass-RLS-but-honor-the-arg pattern). Q4 covers whether RLS-applies for in-process Python callers using `service_role`.

**Migration number:** 060 per fire brief. Per CLAUDE.md doctrine, if codex lands a migration before this one rebases, bump to next-available and update the file name + the rollback comment block.

---

## 3 · Why `lumo_embeddings`, not `unified_embeddings`

Same call as v1 of this doc, even more clear-cut now that the schema explicitly drops `text` and the surface explicitly omits cascade triggers.

| Axis | `unified_embeddings` (migration 032) | `lumo_embeddings` (this lane) |
|---|---|---|
| Ownership | MMRAG-1 (codex). | Python lanes via `vector_store`. |
| Population | Cascaded from native source tables via projectors (linear weight-matrix transforms into 1024-d unified space). | Direct caller `upsert` via `vector_store.upsert(collection, source_id, source_type, text, metadata)`. |
| Deletion | Trigger family on `content_embeddings` / `image_embeddings` / `audio_transcripts` / `pdf_documents`. | Explicit `vector_store.delete(id, user_id)`. Orphan sweep (when source row dies without caller deleting) is filed as `VECTOR-STORE-ORPHAN-SWEEP-1`. |
| Schema | `modality`, `source_table`, `source_row_id`, `projector_version`, `text_repr`. | `collection`, `source_id`, `source_type`, `metadata`, **no text column**. |
| Embedding source | Linear projector from native model output (CLIP, audio, BERT) into 1024-d unified space. | Direct from `embedding-service.embed_text` / `embed_batch` (BGE-large-en-v1.5). Same 1024-d, no projection. |
| Read path | `lumo_recall_unified` RPC — joins across source tables, runs cross-encoder re-ranker. | `lumo_embeddings_search` RPC — single-table, no re-ranker (re-ranking is `PYTHON-RETRIEVAL-PLATFORM-1`'s lane per fire brief OUT-OF-SCOPE). |
| Cardinality | High — every native row has a matching unified row. | Caller-driven; varies by collection. |
| Cross-substrate UNION | Possible at query time via `VECTOR-STORE-UNIFIED-RECALL-1` follow-up if a workflow ever needs it. | Same. |

---

## 4 · Backend abstraction (pgvector now, Qdrant later)

```python
# apps/ml-service/lumo_ml/core/vector_store.py
class _Backend(Protocol):
    async def upsert(self, record: _StoredRecord) -> _UpsertResult: ...
    async def search(self, req: _SearchRequest) -> list[_SearchHit]: ...
    async def delete(self, *, id: str, user_id: str) -> bool: ...
    async def count(self, *, user_id: str, collection: str | None) -> int: ...

_BACKEND: _Backend = _PgVectorBackend()    # v1; Qdrant fallback selectable later
```

`_PgVectorBackend` calls `lumo_embeddings_search` RPC + raw INSERTs / DELETEs through supabase-py. The Protocol defines the seam so `_QdrantBackend` (when it lands) just slots in behind the feature flag.

The fire brief's "optional Qdrant on Modal Volume for hot collections" is two-axis: (a) per-collection backend selection vs (b) per-deployment backend swap. v1 design supports per-deployment swap via env var (simpler); per-collection routing is a follow-up (`VECTOR-STORE-BACKEND-PER-COLLECTION-1`). Q3 covers.

---

## 5 · Index strategy — tiered per collection

The fire brief's tiering:

| Collection size                              | Index            | Why                                                                                       |
|----------------------------------------------|------------------|-------------------------------------------------------------------------------------------|
| `<` 1,000 rows                                | **No index** (linear scan) | HNSW build cost > scan cost at this size; index pages waste cache. |
| 1,000–100,000 rows, **hot** (high read ratio) | **HNSW**         | Best p99 latency at this size; `m=16 / ef_construction=64` mirrors ADR-011 §4 sealed parameters. |
| `>` 1,000 rows, **cold** (low read ratio)     | **ivfflat**      | Faster build, faster updates, slightly lower recall — fine for cold-path collections.     |

**v1 implementation question (Q5):** the brief reads as a strategy guide for v1, but executing per-collection tiering requires either:

- **(a) Postgres declarative partitioning** — `partition by list (collection)`. Each partition gets its own index based on the registered tier. Pros: native, partition pruning makes single-collection queries fast; per-partition indexes work as designed. Cons: schema-management complexity; collection registration becomes a DDL operation; cross-collection queries scan all partitions.
- **(b) Separate tables per collection** — `lumo_embeddings_<collection>`. Same idea, manual schema sync. Pros: total isolation. Cons: ALTER coordination across N tables when adding columns.
- **(c) Single table, HNSW always v1; tiering as Phase-2 follow-up** — `lumo_embeddings` with one table-level HNSW index. Tiering implementation (via partitioning or otherwise) lands once we have measured need.

**Recommended default: (c).** Reasons:
1. Day-1 partitioning is complexity ahead of measured need. Most v1 collections will be <100k.
2. HNSW recall + latency are acceptable across the entire 0–1M range with the ADR-011 §4 parameters.
3. The tiering benefits manifest at extremes (linear scan beats HNSW only when collection is genuinely tiny; ivfflat wins on cold collections only when build/update cost matters).
4. Migration to partitioning is a one-time DDL operation when fired; not a destructive choice.

If reviewer flips Q5 to (a), the implementation lane includes the partitioning DDL + a `lumo_embedding_collections` registration table that tracks the per-collection tier choice.

---

## 6 · Public surface — text-in, search-out

```python
# apps/ml-service/lumo_ml/core/vector_store.py
from typing import Annotated, Any, Literal
from pydantic import BaseModel, Field, field_validator
from lumo_ml.core import Secret, traced, record_cost
from lumo_ml.core.embeddings import (
    Embedding, ModelVersion, DIMENSIONS,
    embed_text, embed_batch,
)


_COLLECTION_RE = r"^[a-z][a-z0-9_]{1,63}$"
_SOURCE_TYPE_RE = r"^[a-z][a-z0-9_]{1,63}$"


class UpsertRequest(BaseModel):
    collection: str = Field(..., pattern=_COLLECTION_RE)
    source_id: str = Field(..., min_length=1, max_length=128)
    source_type: str = Field(..., pattern=_SOURCE_TYPE_RE)
    text: Annotated[str, Secret] = Field(..., min_length=1, max_length=8192)
    metadata: dict[str, Any] = Field(default_factory=dict)
    user_id: str                                                     # opaque; not Secret


class UpsertResponse(BaseModel):
    id: str
    inserted: bool                                                   # False = updated existing


class SearchFilter(BaseModel):
    source_type: str | None = Field(None, pattern=_SOURCE_TYPE_RE)
    # Add more facet filters here (created_after, metadata_eq) via follow-ups.


class SearchRequest(BaseModel):
    collection: str = Field(..., pattern=_COLLECTION_RE)
    query: Annotated[str, Secret] = Field(..., min_length=1, max_length=8192)
    top_k: int = Field(default=10, ge=1, le=100)
    filter: SearchFilter = Field(default_factory=SearchFilter)
    user_id: str


class SearchHit(BaseModel):
    id: str
    source_type: str
    source_id: str
    metadata: dict[str, Any]
    score: float                                                     # cosine similarity ∈ [0, 1]
    model_version: ModelVersion
    created_at: str                                                  # ISO-8601


class SearchResponse(BaseModel):
    hits: list[SearchHit]


class CountRequest(BaseModel):
    user_id: str
    collection: str | None = Field(None, pattern=_COLLECTION_RE)


@traced("vector_store.upsert")
async def upsert(req: UpsertRequest) -> UpsertResponse:
    # 1. Embed text via embedding-service.
    # 2. Validate emitted Embedding.model_version against allowed Literal.
    # 3. INSERT ... ON CONFLICT (user_id, collection, source_type, source_id)
    #    DO UPDATE SET vector = EXCLUDED.vector, metadata = EXCLUDED.metadata,
    #                  created_at = lumo_embeddings.created_at;  -- preserve original
    # 4. record_cost (see §10).
    ...


@traced("vector_store.search")
async def search(req: SearchRequest) -> SearchResponse:
    # 1. Embed query text via embedding-service.
    # 2. Call lumo_embeddings_search RPC.
    # 3. record_cost with embed-leg + search-leg attributes (§10).
    ...


@traced("vector_store.delete")
async def delete(*, id: str, user_id: str) -> bool: ...


@traced("vector_store.count")
async def count(req: CountRequest) -> int: ...
```

**Why text-in (not Embedding-in):** the fire brief's API is `vector_store.upsert(collection, source_id, text, metadata)` — vector_store owns the embed step. This is the right abstraction for a primitive used by memory + retrieval + recommendations: every caller would otherwise call `embedding-service.embed_text()` then forward the result, three lines of boilerplate per call site that is exactly the seam vector_store is supposed to absorb. Single ownership of the embed-then-store transaction also makes the model_version contract harder to violate.

**Why `Annotated[str, Secret]` on `text` and `query`:** both are user-derived. `model_dump_for_logs` redacts; spans don't leak content.

**Why a separate `_BackendInternal` shape vs the public Pydantic models:** the public types are stable contract; backend types can iterate. The Protocol in §4 takes `_StoredRecord` / `_SearchRequest` (private) so swapping backends doesn't ripple into the public API.

---

## 7 · RLS — user-scoped, sharing deferred

Per fire brief: *"users only see their own embeddings unless explicitly shared."*

**v1:** owner-only read + write via Postgres RLS policies on `lumo_embeddings`. The `auth.uid() = user_id` check applies for `authenticated` role. `service_role` bypasses RLS entirely and uses the `user_id` argument as the trust boundary.

**Sharing mechanism:** deferred to `VECTOR-STORE-SHARING-1` follow-up. Open design surface includes per-row ACL JSONB column vs. separate `lumo_embedding_shares` table vs. RLS policy keyed on a `shared_with` array. v1 has zero sharing — keeps the security surface minimal until a real use case fires.

**Integration test (per fire brief acceptance):** create two test users, upsert vectors as user A, verify user B's authenticated client gets zero rows from `search()` and zero from `count()`. Skip if `LUMO_TEST_SUPABASE_URL` unset; CI runs against a fresh Supabase test schema.

**`security invoker` on the search RPC** (§2): RLS applies when authenticated callers invoke the RPC; service_role callers bypass RLS and the function honors the explicit `p_user_id` argument as the trust boundary. Q4 documents this; reviewer can flip to `security definer` if the semantics need to differ.

---

## 8 · Reindexing on `model_version` change

Per fire brief: *"when model_version changes, what's the migration path? Recommend: dual-write window, lazy backfill, then drop old vectors."*

**Three-phase playbook:**

```text
Phase 1 — Dual-write window (length: 14 days default)
─────────────────────────────────────────────────────
ALTER TABLE lumo_embeddings DROP CONSTRAINT lumo_embeddings_model_version_check;
ALTER TABLE lumo_embeddings ADD CONSTRAINT lumo_embeddings_model_version_check
  CHECK (model_version IN ('bge-large-en-v1.5', 'bge-large-en-v2.0'));

embedding-service.ModelVersion = Literal["bge-large-en-v1.5", "bge-large-en-v2.0"]
embedding-service.DEFAULT_MODEL = "bge-large-en-v2.0"   # new writes get the new model

vector_store.upsert(): always writes new model
vector_store.search(): queries with new model, falls back to old-model embeddings
                       if a user has no v2 rows yet for the queried collection
                       (per-user, per-collection fallback flag).

Phase 2 — Lazy backfill on touch (length: 30 days default)
──────────────────────────────────────────────────────────
On every successful `vector_store.upsert(...)`: also re-upsert any sibling
old-model rows for the same (user_id, collection, source_type, source_id).
"Touched" rows migrate; cold rows stay until phase 3.

Background sweep job (filed as VECTOR-STORE-LAZY-BACKFILL-1) drains the
long tail at low priority; bounded by a per-tick row cap so it never
saturates the embed_batch pipeline.

Phase 3 — Drop old vectors (when v1 row count < 1% of total per collection)
───────────────────────────────────────────────────────────────────────────
DELETE FROM lumo_embeddings WHERE model_version = 'bge-large-en-v1.5';
ALTER TABLE lumo_embeddings DROP CONSTRAINT lumo_embeddings_model_version_check;
ALTER TABLE lumo_embeddings ADD CONSTRAINT lumo_embeddings_model_version_check
  CHECK (model_version IN ('bge-large-en-v2.0'));
```

**Why lazy not eager:** eager re-embedding of every existing row at the moment the new model lands is a thundering-herd of `embed_batch` calls that risks Modal cold-start cascades and runs up the cost meter all at once. Lazy backfill amortizes the work over real traffic; the sweep drains the cold tail at controlled rate.

**Failure mode discipline:** during phase 1, a `search()` that gets zero v2 hits and falls back to v1 logs a `vector_store.search.fallback` span attribute so the dashboard can see the migration progressing. Phase 3 doesn't kick off until the v1 fallback rate is below threshold across all collections.

**Filed as:** `VECTOR-STORE-MODEL-MIGRATION-PLAYBOOK-1` — the playbook lives in this design doc; the actual phase-2 lazy-backfill background sweep is a follow-up implementation lane that fires when the second `model_version` lands.

---

## 9 · @traced surface + lint-scope alignment

Every public function in `lumo_ml/core/vector_store.py` is `@traced`:

| Function | `@traced` operation        |
|----------|----------------------------|
| `upsert` | `vector_store.upsert`      |
| `search` | `vector_store.search`      |
| `delete` | `vector_store.delete`      |
| `count`  | `vector_store.count`       |

**Lint-scope alignment:** per the sequencing in the fire brief preamble, embedding-service-1 implementation lands the `lumo_ml/core/`-in-scope refinement (Q8 of that doc, defaulted to "ship under embedding-service-1"). When this lane rebases, it inherits the new boundary — `lumo_ml/core/vector_store.py` is automatically in scope. The lane just adds new `@traced`-decorated public functions that pass the lint.

**No additional lint-script changes in this lane** — that's the whole point of the pairing. If embedding-service-1 ships and the refinement isn't in (reviewer flips Q8), this lane ships the refinement instead. Same diff, different commit.

---

## 10 · Cost telemetry — embed-leg + search-leg attribution

Vector-store calls embedding-service internally; both legs cost. The `record_cost` payload reflects the composition:

```python
@traced("vector_store.upsert")
async def upsert(req: UpsertRequest) -> UpsertResponse:
    embed_started = monotonic()
    embedding_resp = await embed_text(EmbedTextRequest(text=req.text))
    embed_elapsed = monotonic() - embed_started

    db_started = monotonic()
    record = await _BACKEND.upsert(...)
    db_elapsed = monotonic() - db_started

    record_cost(
        "vector_store.upsert",
        embedding_ops=1,
        gpu_seconds=embed_elapsed,         # embed-leg only; DB call is CPU
        dollars_estimated=embedding_resp.dollars_estimated,  # passes through embed-leg cost
        metadata={
            "collection": req.collection,
            "source_type": req.source_type,
            "embed_ms": int(embed_elapsed * 1000),
            "db_ms":    int(db_elapsed * 1000),
            "model_version": embedding_resp.embedding.model_version,
            "inserted": record.inserted,
        },
    )
    return record
```

Same shape for `search` (one embed call + one RPC call). For `delete` and `count`, no embed leg; `dollars_estimated=0.0` and `metadata.db_ms` is the only meaningful cost.

**Embed-leg cost is *not* double-counted** even though `embed_text` itself emits a `record_cost("embedding.bge_large.embed_text", ...)` from inside its own span. The two records sit on different spans; the dashboard groups by operation. `vector_store.upsert.dollars_estimated` is the rolled-up "what did this single upsert cost end-to-end"; `embedding.bge_large.embed_text.dollars_estimated` is the bottoms-up "how much did the embed call cost." Codex's plan-client logger consumes both into `agent_cost_records`; aggregation is a downstream concern.

---

## 11 · Open questions for reviewer

| #   | Question | Recommended default |
|-----|----------|---------------------|
| Q1  | Migration number — 060 per fire brief, but if codex lands a migration first, bump? | **060 if available; bump otherwise** — per CLAUDE.md doctrine, coordinate via STATUS.md. No active migrations in the codex lane at fire time. |
| Q2  | Table name `lumo_embeddings` (per fire brief) vs the v1 doc's `lumo_vectors`? | **`lumo_embeddings`** — fire brief is canonical. |
| Q3  | Backend selection: per-deployment env var (recommended v1) vs per-collection routing (richer; deferred)? | **Per-deployment v1** — `LUMO_VECTOR_STORE_BACKEND=pgvector`. Per-collection routing as `VECTOR-STORE-BACKEND-PER-COLLECTION-1` follow-up. |
| Q4  | RPC `security invoker` (RLS auto-applies for authenticated callers) vs `security definer` (function bypasses RLS, runs as owner)? | **`security invoker`** — Postgres-native RLS as the default trust boundary; `service_role` bypasses RLS via role permissions, not via the function's security mode. |
| Q5  | Index tiering at v1 — Postgres declarative partitioning with per-partition indexes (a) vs separate tables per collection (b) vs single table HNSW + tiering as Phase-2 follow-up (c)? | **(c)** — single-table HNSW v1; tiering as `VECTOR-STORE-INDEX-TIERING-1` once measured need exists. Day-1 partitioning is complexity ahead of need. |
| Q6  | `model_version` enforcement at DB layer: enumerated check constraint (recommended) vs FK to a `lumo_model_versions` lookup table? | **Enumerated check** — single column, no JOIN, ALTER on widening is one migration. Lookup table is overkill until 4+ versions live. |
| Q7  | Should `upsert()` preserve `created_at` on conflict (recommended) or refresh to `now()`? | **Preserve original `created_at`** — semantically the row is a continuation of the same logical record; the `unique` constraint enforces the identity. Refreshing breaks created-at-based ordering. |
| Q8  | `SearchFilter` v1 surface — only `source_type` (recommended) vs the broader (`created_after`, `metadata_eq`, etc.) brief implied? | **`source_type` only v1** — the brief's "filter" example was intentionally minimal. Other facets land via follow-ups (`VECTOR-STORE-SEARCH-FILTERS-1`) once concrete callers fire. |
| Q9  | Probe-time `hnsw.ef_search`: pgvector default (40) vs higher for better recall? | **Default 40 v1** — measured recall@10 on canonical fixtures decides the bump (`VECTOR-STORE-EF-SEARCH-TUNE-1` follow-up). |
| Q10 | Hard cap on `top_k` server-side? | **100** — matches RPC `LIMIT greatest(1, least(p_top_k, 100))`. Higher caps invite cost surprises; raise via follow-up if a caller proves the need. |
| Q11 | Soft-delete (`deleted_at`) vs hard `delete`? | **Hard delete v1** — soft-delete adds `WHERE deleted_at is null` to every read for benefit nobody's asked for. Re-evaluate on first compliance ask. |
| Q12 | Orphan sweep (when source row dies but caller forgot to call `vector_store.delete`)? | **Filed as `VECTOR-STORE-ORPHAN-SWEEP-1` follow-up; not in v1.** v1 trusts callers; sweep catches drift at scale. |
| Q13 | Cross-stack consumer: TS-side client wrapper from codex's web layer? | **Codegen-only v1** — codex pulls Pydantic types via existing pydantic-to-typescript pipeline; HTTP endpoint shape is the contract. Wrapper is a TS-side decision. |

---

## 12 · Implementation plan (subject to reviewer answers)

Once approved, single push lands (after embedding-service-1 + OBSERVABILITY-LINT-COVERAGE-1 are on `origin/main`):

1. **Migration 060** (`db/migrations/060_lumo_embeddings.sql`): table, indexes, RLS, `lumo_embeddings_search` RPC, rollback comment block.
2. **`apps/ml-service/lumo_ml/core/vector_store.py`**: schemas (`UpsertRequest`, `UpsertResponse`, `SearchRequest`, `SearchHit`, `SearchResponse`, `SearchFilter`, `CountRequest`), `_BACKEND` Protocol + `_PgVectorBackend` impl, `upsert` / `search` / `delete` / `count` async functions wrapping the backend.
3. **`apps/ml-service/lumo_ml/core/__init__.py`**: re-export public surface.
4. **Pydantic codegen run** → `packages/lumo-shared-types/` regenerated; commit with the same lane.
5. **Tests** (`apps/ml-service/tests/test_vector_store.py`):
   - **Round-trip** (per fire brief acceptance): `upsert` → `search(top_k=1)` → top hit is the upserted record.
   - **Filter / RLS** (per fire brief acceptance): two test users; user A upserts; user B's authenticated client gets zero rows from `search` and `count`. Skip if `LUMO_TEST_SUPABASE_URL` unset.
   - **Reindex** (per fire brief acceptance): synthetic two-model-version setup; verify dual-write reads from both, lazy-backfill regenerates touched rows; phase-3 DROP succeeds when v1 row-count = 0.
   - **Latency budget** (per fire brief acceptance): seed 100k vectors into a test collection; assert p95 ≤ 100ms for top-10 `search` over 50 trials. Skip if `LUMO_TEST_SUPABASE_URL` unset.
   - **Schema contract**: `model_version` Literal rejects unknown; `dimensions` mismatch rejected; collection / source_type regex rejection.
   - **`record_cost` emission**: each public function emits the expected operation; embed-leg + db-leg attributes present (OTel test exporter).
   - **Migration round-trip**: rollback + replay leaves the table identical.
6. **Gates:** `ruff` clean / `mypy` 0 issues / `pytest` green / `lint-traced-coverage.py` clean on the new file (lint scope refined by embedding-service-1) / migration runs cleanly against a fresh Supabase test DB.

**Out of scope this lane (per fire brief):**
- Hybrid retrieval (BM25 + dense) — separate lane `PYTHON-RETRIEVAL-PLATFORM-1`.
- Reranking — separate lane.
- Per-collection backend routing — `VECTOR-STORE-BACKEND-PER-COLLECTION-1`.
- Index tiering implementation (partitioning) — `VECTOR-STORE-INDEX-TIERING-1`.
- Sharing mechanism — `VECTOR-STORE-SHARING-1`.
- Orphan sweep — `VECTOR-STORE-ORPHAN-SWEEP-1`.
- Quarterly HNSW rebuild — `VECTOR-STORE-INDEX-MAINT-1`.
- ef_search tuning — `VECTOR-STORE-EF-SEARCH-TUNE-1`.
- Per-query dollar calibration — `VECTOR-STORE-COST-CALIBRATION-1`.
- Cross-substrate UNION recall with `unified_embeddings` — `VECTOR-STORE-UNIFIED-RECALL-1`.
- Lazy backfill background sweep — `VECTOR-STORE-LAZY-BACKFILL-1` (fires when second model version lands).
- Search-filter expansion (`created_after`, `metadata_eq`) — `VECTOR-STORE-SEARCH-FILTERS-1`.

---

## 13 · Coordination + scope discipline

**In-scope this lane:**
- `db/migrations/060_lumo_embeddings.sql` (new)
- `apps/ml-service/lumo_ml/core/vector_store.py` (new)
- `apps/ml-service/lumo_ml/core/__init__.py` (re-export)
- `apps/ml-service/docs/designs/vector-store.md` (this file)
- `apps/ml-service/tests/test_vector_store.py` (new)
- `packages/lumo-shared-types/**` (codegen output)
- *(Conditional, only if embedding-service-1 didn't ship the lint-scope refinement)*: `scripts/lint-traced-coverage.py` + `CONTRIBUTING.md` §1.1.

**Cross-lane coordination via STATUS.md:**
- Migration 060 is the next number after PYTHON-OBSERVABILITY-1's 059. Active table at brief time shows no migrations in flight from codex; if one lands while this lane is open, rebase additively and bump (Q1).
- `ModelVersion`, `DIMENSIONS`, `embed_text`, `embed_batch` are *imported* from `lumo_ml/core/embeddings.py`. Type-checking catches drift.

**Out-of-scope cross-lane coordination:**
- `apps/web/**` — codex's lane. The cross-stack TS-side client (if/when needed) is a TS-side decision (Q13).
- `apps/ios/**` — claude-code's lane; not in dependency path.

**Filed follow-ups (post-approval queue):**
- `VECTOR-STORE-INDEX-TIERING-1` — Postgres declarative partitioning + per-partition tier indexes (no-index <1k / HNSW <100k hot / ivfflat ≥1k cold).
- `VECTOR-STORE-INDEX-MAINT-1` — quarterly HNSW rebuild cron (mirrors ADR-011 §14 cadence for `unified_embeddings`).
- `VECTOR-STORE-EF-SEARCH-TUNE-1` — measure recall@10 vs `ef_search` on canonical fixtures; bump default if warranted.
- `VECTOR-STORE-COST-CALIBRATION-1` — measure per-query compute once table grows past 100k rows.
- `VECTOR-STORE-UNIFIED-RECALL-1` — UNION query path across `lumo_embeddings` and `unified_embeddings` if a workflow requires cross-substrate recall.
- `VECTOR-STORE-QDRANT-FALLBACK-1` — Qdrant on Modal Volume backend, fired when any collection >10M rows or p95 search latency >250ms despite tuning.
- `VECTOR-STORE-BACKEND-PER-COLLECTION-1` — per-collection backend routing (vs the v1 per-deployment env var).
- `VECTOR-STORE-SHARING-1` — sharing mechanism design (per-row ACL vs separate shares table vs RLS-policy `shared_with` array).
- `VECTOR-STORE-ORPHAN-SWEEP-1` — background sweep that detects vectors whose `(source_type, source_id)` no longer resolves to a live source row.
- `VECTOR-STORE-LAZY-BACKFILL-1` — background sweep that drains the cold tail of phase-2 lazy backfill (fires when second model version lands).
- `VECTOR-STORE-SEARCH-FILTERS-1` — broader filter facets (`created_after`, `metadata_eq`, etc.) once concrete callers fire.
- `VECTOR-STORE-MODEL-MIGRATION-PLAYBOOK-1` — the §8 playbook lives in this doc; the dual-write window + sweep implementation fires alongside the second `model_version`.

---

## 14 · What I'm waiting on before scope work

1. Reviewer approval on the 13 open questions in §11 (or counter-recommendations).
2. Embedding-service-1 implementation lands on `origin/main` (it ships the `ModelVersion` Literal + `DIMENSIONS` + `embed_text` / `embed_batch` this lane imports, and the `lumo_ml/core/`-in-scope lint refinement that this lane assumes).
3. `OBSERVABILITY-LINT-COVERAGE-1` lands on `origin/main` first (the lint refinement edits the version of the script that lane introduces).
4. Sequencing per fire brief: 1) lint-coverage-1 → 2) embedding-service-1 → 3) this lane.
