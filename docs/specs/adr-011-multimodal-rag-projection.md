# ADR-011 — Multi-modal RAG Projection

**Status:** Accepted (sealed 2026-04-27). Codex MMRAG-1 implements against this ADR.
**Authors:** Coworker A (architecture pass), reviewed by Kalas.
**Related:** `docs/specs/lumo-intelligence-layer.md`,
`docs/specs/phase-4-outlook.md`, `docs/specs/phase-3-master.md` (MMRAG-1 entry).
**Implements:** the unified retrieval substrate that lets a single
recall query hit text, image, and audio-derived embeddings together.

---

## 1. Context

Phase-2 left Lumo with three native embedding spaces:

- **Text** — `sentence-transformers/all-MiniLM-L6-v2`, 384-dim,
  stored in `content_embeddings`. Covers connector text snippets,
  audio-transcript chunks, PDF page text.
- **Image (CLIP)** — OpenCLIP ViT-B/32, 512-dim, stored in
  `image_embeddings`. Covers user-uploaded images. CLIP zero-shot
  labels are also redacted-and-indexed back into
  `content_embeddings` as text, but the *native* image vector
  lives separately.
- **Audio-via-text** — Whisper transcripts indexed as text in
  `content_embeddings`. Audio itself does not have a separate
  vector store today.

Today's recall flow searches `content_embeddings` only. A user who
asks "show me the receipt photo from the Vegas trip" gets back the
CLIP-label text ("receipt") if it happened to be redacted into the
text index, but does not get a vector-similarity hit on the actual
image. A user who asks "find the moment in the meeting where Alice
mentioned the contractor" gets the transcript text, but if the
question is image-shaped (a screenshot of the slide) we have no
unified path.

Phase-4 GraphRAG and the conversational explainer assume a single
query can return mixed-modality candidates ranked together. MMRAG-1
is that substrate.

The decision is the projection strategy.

---

## 2. Options considered

### Option (A) — Project everything to a single unified embedding space

Train (or fine-tune) a small linear projector per modality that maps
into a shared `d`-dim space. Store projected vectors in a single
HNSW-indexed pgvector column. Recall queries hit one index.

**Pros.** One index, one query, rank-merge for free. The unified
space is the obvious right answer for cross-modal retrieval.

**Cons.** Projector training is a real piece of work — needs a
contrastive dataset (text-image pairs, transcript-audio segment
pairs). Modality drift: as we add modalities later, every modality's
projector has to be re-aligned. Recall@5 on the unified space is
typically 5-10% worse than searching native spaces and rank-merging
afterwards.

### Option (B) — Search native spaces, rank-merge with reciprocal-rank-fusion

Keep `content_embeddings` (text), `image_embeddings` (CLIP), and a
new `audio_embeddings` (CLAP or wav2vec2) separate. At query time,
issue three vector searches in parallel, rank-merge results via
RRF.

**Pros.** No projection layer to train. Each native space stays at
its native quality. Easy to add modalities — just add another
search and merge.

**Cons.** Three queries instead of one. Latency goes up
proportionally with modality count. Rank-merge is a heuristic; tied
scores in different modalities are hard to compare. The query has
to be encoded in *every* modality (text query → text vector;
text query → CLIP-text vector; text query → CLAP-text vector),
which is its own re-embedding cost.

### Option (C) — Native + cheap cross-modal re-ranker

Search native spaces in parallel (B), then run a small CPU
cross-encoder over the union of top-`k` candidates to produce a
unified ranking. The re-ranker takes the query text and a candidate's
text representation (transcript text for audio, CLIP-label text +
EXIF metadata for image, raw text for text).

**Pros.** Best recall in published benchmarks. Re-ranker latency is
bounded by `k` (typically 20-50 candidates). No projection-layer
training.

**Cons.** Most complex. Three searches plus a re-ranker. The
re-ranker has its own model to maintain.

---

## 3. Decision

**Adopt Option (A) — learned linear projectors to a 1024-dim
unified space — as the v1 substrate, with a cheap CPU
cross-encoder re-ranker over the top-`k` for the final ordering.**

This is a deliberate hybrid: projection gets us a single index
and a single query (the win of A); the re-ranker recovers the
recall gap that B+C optimise for.

Rationale:

- **One index.** GraphRAG's path-citation logic (ADR-008)
  benefits from a single retrieval call returning unified-space
  candidates with provenance. Three indexes complicate the
  graph-traversal-cued recall pattern.
- **1024-dim is a deliberate choice.** Larger than the native
  text (384) and CLIP (512) spaces, which gives the projectors
  headroom to preserve modality-specific information without
  collapsing it. Smaller than 1536-dim (the OpenAI
  text-embedding-ada-002 dimension) so we don't pay extra storage
  and HNSW index cost.
- **Linear projectors.** Not MLPs. Linear keeps the operation
  cheap (a 384x1024 matmul for text, 512x1024 for image),
  trainable on a small contrastive dataset, and trivially
  invertible for debugging.
- **HNSW in pgvector.** Already supported on Supabase managed
  Postgres. We do not need a new vector vendor.

---

## 4. Schema

### New unified embedding table

```sql
create table public.unified_embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  modality text not null,                   -- 'text' | 'image' | 'audio'
  source_table text not null,               -- 'content_embeddings', 'image_embeddings', 'audio_transcripts', etc.
  source_row_id text not null,              -- back-reference to the native row
  source_url text,                          -- citation URL when applicable
  text_repr text,                           -- text representation used by the re-ranker; required for non-text modalities
  embedding vector(1024) not null,
  projector_version text not null,          -- e.g. 'v1.0-text', 'v1.0-clip', 'v1.0-audio'
  created_at timestamptz not null default now(),
  unique (source_table, source_row_id, projector_version)
);

create index unified_embeddings_user_modality
  on public.unified_embeddings (user_id, modality);
create index unified_embeddings_hnsw
  on public.unified_embeddings using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
```

Native tables stay as-is. Unified rows are derived; deletion of a
native row cascades to the unified row via a trigger.

### Projector artifacts

`projector_artifacts(version, modality, weights bytea, created_at)`
stores the projector weight matrices. Brain loads them at startup
and caches in memory. Re-training writes a new `version` row; brain
hot-swaps within 5 minutes of deploy via a watcher.

---

## 5. Projector training

### Dataset

- **Text-image pairs.** ~5,000 pairs from a public CC-licensed
  dataset (e.g., LAION-aesthetics subset filtered to the
  product/document/screenshot distribution we expect Lumo users to
  have). Pairs are (caption, image).
- **Text-transcript pairs.** ~2,000 pairs from a public
  transcribed-audio corpus (LibriSpeech excerpts) where the text
  is the transcript and the embedding source is the same
  transcript run through the text encoder. (For audio-via-text we
  do not need a separate audio encoder; the audio modality
  re-uses the transcript text and learns to project from a
  whisper-distilled summary.)
- **Negative pairs** sampled within batch via standard
  contrastive learning.

The dataset is intentionally small. The projectors are linear, the
input and target dims are small, and we are not learning a new
encoder — we are learning an alignment of three already-trained
encoders. ~10k pairs total is enough.

### Training

- InfoNCE loss with temperature 0.07.
- AdamW, lr=1e-3, 30 epochs, batch 256.
- Trains in ~30 minutes on a single Modal A10G.
- Output: three weight matrices (text 384x1024, image 512x1024,
  audio 384x1024 — note audio re-uses the text encoder).

### Re-training cadence

- Initial training before MMRAG-1 ships.
- Re-train when a new modality is added (Phase-5+: video,
  structured-table-as-image).
- Re-train every 6 months as a hygiene pass; verify recall@5
  on the held-out set has not regressed by >5%.

---

## 6. Cross-modal re-ranker

A cheap CPU model that takes `(query_text, candidate_text_repr)` and
emits a similarity score. Used to re-order the top-`k` (k=30)
candidates returned from the HNSW search.

- **Model.** `cross-encoder/ms-marco-MiniLM-L-6-v2` (22M params,
  CC-BY-4.0). Runs ~150 query-candidate pairs per second on a
  Cloud Run vCPU.
- **Latency budget.** Re-ranker over 30 candidates: p95 < 250ms.
- **Output.** Re-ordered top-`k`, where k is the requested
  result count (typically 5-10).
- **Fallback.** If the re-ranker times out or errors, return the
  HNSW-ranked candidates directly. The `recall` response includes
  a `reranker_engaged: bool` flag.

The re-ranker uses the `text_repr` column on `unified_embeddings`.
For images, `text_repr` is the CLIP zero-shot label set + EXIF
date/location summary. For audio, it is the transcript text. For
text it is the text itself.

---

## 7. Re-embedding cost trade-off

Adopting the unified space requires re-embedding all existing
native rows once. Costs at current scale:

| Source | Row count (Vegas test user) | Re-embed cost |
|---|---:|---|
| `content_embeddings` (text) | ~12,000 | $0.00 (linear projector, no encoder call) |
| `image_embeddings` (CLIP) | ~400 | $0.00 (linear projector) |
| `audio_transcripts` (text) | ~150 | $0.00 (linear projector) |
| `pdf_documents` chunks | ~800 | $0.00 (linear projector) |

The win: linear projectors run as a single matrix multiply per
batch. We do not re-call the underlying encoders. Initial backfill
is CPU-bound and free. At 1k MAU projection (~10M rows total),
the backfill takes a single Modal job of <2 hours.

Ongoing cost: every new native-table insert triggers one projector
call to write the unified-table row. Projector calls cost nothing
material; the real cost is the existing native-encoder calls
(text MiniLM, CLIP, Whisper) which we already pay.

---

## 8. Modality drift

As Phase 4 progresses, we will likely add:

- **Video.** Frame-sampled CLIP embeddings + audio-track transcript.
  Expected Phase-5+ Sprint 1.
- **Structured tables.** Cell-level text + a small layout encoder.
  Expected Phase-5+ Sprint 2.
- **Code.** A small code-specific encoder (e.g., CodeBERT). Not
  on the v1 roadmap but plausible.

Each new modality requires:

1. A new native encoder (existing model or new).
2. A new linear projector (trained on contrastive pairs against
   the existing modalities).
3. A new `text_repr` recipe for the re-ranker.

Existing projectors do *not* need re-training when a new modality
is added — the unified space is shared, and contrastive training
of the new projector against the existing space preserves prior
alignment. We verify this with a held-out recall@5 test before
shipping a new modality.

---

## 9. Quality targets

| Metric | Target | Measurement |
|---|---|---|
| Recall@5 (unified) | ≥ 0.70 | Held-out 200-query test set; query crosses modalities |
| Recall@5 (text-only baseline) | ≥ 0.65 (stay above) | Same test set, text-only retrieval |
| Cross-modal recall@5 (image queries) | ≥ 0.55 | Subset of the test set with image-shaped questions |
| HNSW search latency | p95 < 200ms | At 1M unified rows, ef=64 |
| Re-ranker latency (k=30) | p95 < 250ms | On Cloud Run with 1 vCPU |
| End-to-end recall latency | p95 < 1000ms | Query embed + HNSW + re-rank + envelope |

Recall@5 ≥ 0.70 is the must-hit target. The text-only baseline must
not regress (the unified space cannot be a downgrade).

---

## 10. Brain tools

Two new tools, both follow the existing brain-tool envelope:

- `lumo_recall_unified(user_id, query, filters, top_k)` →
  `{ candidates[], reranker_engaged, latency_ms }`. Replaces the
  existing `lumo_recall` for new code paths; existing code paths
  stay on the text-only `lumo_recall` until they are migrated
  surface-by-surface.
- `lumo_project_embedding(modality, vector)` →
  `{ unified_embedding[1024] }`. Internal tool used by the
  indexer cron. Not exposed to Core hot path.

`lumo_recall_unified` lives behind `LUMO_MMRAG_ENABLED`. Default
false until backfill completes and recall@5 acceptance passes.

---

## 11. Acceptance criteria for MMRAG-1

MMRAG-1 ships when:

1. Migration adds `unified_embeddings` table and trigger
   cascades from native tables.
2. Projector training runs on Modal, produces v1.0 artifacts,
   uploads to versioned bucket.
3. Backfill cron populates `unified_embeddings` for the Vegas
   test user across all four source tables.
4. `lumo_recall_unified` is live on Cloud Run with the documented
   latency budgets.
5. Held-out test reports recall@5 ≥ 0.70 (unified) and ≥ 0.65
   (text-only baseline preserved).
6. Chat orchestrator's recall code path is migrated for at least
   one user-facing surface (e.g., the workspace recall card)
   behind `LUMO_MMRAG_ENABLED`.
7. Cross-modal smoke: a user asks "show me the receipt from the
   Vegas dinner" and the response cites a CLIP-image hit ranked
   above text hits about Vegas dinner. Citation includes the
   image's source URL.

---

## 12. Latency and fallbacks

Hot-path:

- `lumo_recall_unified` p95: < 1000ms end-to-end.
  - Query embed: < 100ms.
  - HNSW search: < 200ms.
  - Re-ranker over top-30: < 250ms.
  - Network + envelope: ~50ms.

Fallback rules:

- Re-ranker error/timeout → return HNSW-ranked candidates with
  `reranker_engaged: false`.
- HNSW timeout → fall back to `lumo_recall` text-only path.
- Brain unreachable → Core's existing local term-overlap
  fallback over `content_embeddings`.

No surface should block on a slow recall.

---

## 13. Privacy

- `unified_embeddings` is a derivative store. RLS uses `user_id`
  exactly as native tables do.
- Deletion of a native row triggers cascade deletion of the
  unified row.
- The re-ranker operates on `text_repr`, which is already
  redacted text. No raw image bytes pass through the re-ranker.
- Projector training data is public CC-licensed corpora;
  user data is **not** used to train projectors in v1. (We may
  revisit a per-tenant fine-tune in Phase-5+ behind explicit
  opt-in.)

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Projector recall regresses below text-only baseline | Held-out test gate; do not enable LUMO_MMRAG_ENABLED until baseline preserved |
| HNSW index degrades at scale | Monitor ef and m parameters; rebuild quarterly; alert on p95 > 200ms |
| Re-ranker becomes hot-path bottleneck | k cap (30); per-batch CPU budget; can fall back to HNSW-only if degraded |
| Modality drift as new modalities are added | Held-out recall@5 gate before each new-modality launch; rollback path documented |
| Image text_repr is brittle (CLIP labels are noisy) | Add EXIF metadata, OCR text where available; fallback to native CLIP score on tied re-ranker outputs |
| Backfill blows up Cloud Run | Throttled job (1k rows/min cap); off-hours cron |
| Storage cost balloons (extra 1024-dim per row) | At 1M rows, ~4GB pgvector — within Supabase Pro tier; monitor monthly |

---

## 15. Open questions

1. Should `text_repr` for images include OCR'd text where present?
   Recommended yes for v1.5 — adds materially to recall on
   screenshot-heavy users.
2. Per-tenant projector fine-tuning — Phase-5+. Stays out of v1.
3. When do we deprecate the native-only `lumo_recall`? Earliest
   Phase-5; we keep the dual path through Phase-4 to derisk.
4. Can the re-ranker run on-device for short queries? Possibly
   in a future browser-WASM build; not in v1.

---

## 16. Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | Adopt unified 1024-dim space with learned linear projectors per modality |
| 2026-04-27 | Cheap CPU cross-encoder re-ranker over top-30 HNSW candidates |
| 2026-04-27 | Initial dataset: ~10k contrastive pairs from public CC-licensed corpora; user data not used for training |
| 2026-04-27 | HNSW in pgvector (m=16, ef_construction=64); no new vector vendor |
| 2026-04-27 | Native tables stay; `unified_embeddings` is derivative with cascade deletion |
| 2026-04-27 | Recall@5 ≥ 0.70 target; text-only baseline must not regress |
| 2026-04-27 | LUMO_MMRAG_ENABLED default false until acceptance |
