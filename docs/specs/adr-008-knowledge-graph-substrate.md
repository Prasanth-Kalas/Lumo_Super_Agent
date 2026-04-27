# ADR-008 — Knowledge Graph Substrate

**Status:** Accepted (sealed 2026-04-27). Codex KG-1 starts against this ADR.
**Authors:** Coworker A (architecture pass), reviewed by Kalas (CEO/CTO/CFO).
**Related:** `docs/specs/lumo-intelligence-layer.md`,
`docs/specs/phase-4-outlook.md`, `docs/specs/phase-3-master.md` (KG-1 entry).
**Implements:** the substrate beneath GraphRAG, mission-plan reasoning across
historical missions, and the per-user "things Lumo knows about you" surface
that Phase-4 personalisation reads from.

---

## 1. Context

Phase 3 leaves Lumo with a wide but disconnected fact base:

- `content_embeddings` (text, audio, PDF, CLIP-image-summary) is a flat
  pgvector table with no inter-row edges.
- `preference_events`, `mission_execution_events`, calendar/email/YouTube
  rows in `connector_responses_archive` carry implicit relationships
  (this user, this mission, this contact, this calendar event, this
  agent), but those relationships are only recoverable by joining
  multiple tables on hand-written keys.
- `user_facts` stores small atomic facts as 1536-dim OpenAI embeddings
  with no notion of "this fact entails that fact" or "this fact was
  asserted by source X on date Y."

What Lumo cannot do today:

- Answer "who introduced me to the Vegas hotel partner I worked with
  last year" — that requires walking *contact → message → mission →
  agent → contact* across three tables.
- Power GraphRAG retrieval where the LLM is asked to follow a chain of
  citations rather than a flat top-k vector hit.
- Explain *why* a marketplace tile was suggested in terms a user can
  audit ("because you bought from this vendor, who sells through this
  partner, who runs this agent").
- Surface 2nd- and 3rd-degree relationships in the proactive-moment
  generator ("Vegas trip is 7 days out → you have a contact who lives in
  Vegas → that contact is also on Tuesday's calendar").

Phase-4 personalisation, the conversational explainer surface, and the
multi-modal RAG layer all need a substrate that makes these traversals
first-class.

### What is closed

Apache AGE on Supabase managed Postgres. We verified
[Supabase's supported extensions list](https://supabase.com/docs/guides/database/extensions)
on 2026-04-27; AGE is **not** in the list and Supabase has shown no public
roadmap signal toward enabling it. Any plan that puts AGE on Supabase
managed Postgres requires either Supabase to ship that support or us to
move off Supabase managed Postgres entirely. Both of those are bigger
decisions than KG-1 can carry. Treat AGE-on-Supabase as closed for the
v1 substrate.

---

## 2. Options considered

### Option (1) — Relational graph tables on Supabase

Two new tables alongside everything else we already store on Supabase.

```sql
create table public.graph_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  label text not null,                   -- 'contact','mission','agent','event','fact','document','vendor','place'
  external_key text,                     -- stable id for upsert from source rows
  properties jsonb not null default '{}'::jsonb,
  embedding vector(384),                 -- optional; populated for nodes with text content
  hierarchy_path ltree,                  -- optional; for label hierarchies
  source_table text,                     -- provenance, e.g. 'connector_responses_archive'
  source_row_id text,                    -- provenance row id (text to allow uuid or bigint)
  source_url text,                       -- provenance URL where applicable (gmail message link, calendar event link, etc.)
  asserted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, label, external_key)
);

create table public.graph_edges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null references public.graph_nodes(id) on delete cascade,
  target_id uuid not null references public.graph_nodes(id) on delete cascade,
  edge_type text not null,               -- 'mentions','attended','executed_by','introduced','located_in','works_at','related_to','part_of','derived_from'
  properties jsonb not null default '{}'::jsonb,
  weight real not null default 1.0,      -- traversal cost / confidence
  source_table text,
  source_row_id text,
  source_url text,
  asserted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, source_id, target_id, edge_type)
);

create index graph_nodes_user_label on public.graph_nodes (user_id, label);
create index graph_nodes_user_extkey on public.graph_nodes (user_id, label, external_key);
create index graph_nodes_embedding_hnsw
  on public.graph_nodes using hnsw (embedding vector_cosine_ops)
  where embedding is not null;
create index graph_nodes_hierarchy on public.graph_nodes using gist (hierarchy_path)
  where hierarchy_path is not null;
create index graph_edges_user_source on public.graph_edges (user_id, source_id, edge_type);
create index graph_edges_user_target on public.graph_edges (user_id, target_id, edge_type);
```

Traversals run as recursive CTEs against these tables (template in §6).

**Pros.** Single Postgres, no new infra, no ETL, no eventual-consistency
story between two stores. RLS extends naturally to the graph (every
graph row carries `user_id`). pgvector and ltree are already enabled on
Supabase managed Postgres — the embedding-cued traversal and hierarchy
path features cost us nothing extra. Ships fastest.

**Cons.** No Cypher. Recursive CTEs beyond 3-4 hops get hairy and the
query planner doesn't do graph-shaped optimisations. Bidirectional
shortest-path is a hand-written CTE. Cycle detection has to be coded
into every traversal.

### Option (2) — Cloud SQL Postgres + Apache AGE as a graph sidecar

Stand up a separate Postgres instance we control on Cloud SQL with the
AGE extension installed. ETL nightly from Supabase to the sidecar.
Run Cypher against AGE for graph queries; the sidecar is read-only.

**Pros.** Real graph query language. Mature traversal engine.
Cypher-shaped queries are far more legible than recursive CTEs at 3+
hops. Open-ended exploration ("find any path between A and B with
length <=5 weighted by edge type") becomes one query.

**Cons.** New Postgres to operate (backups, patching, monitoring,
auth). ETL between Supabase and the sidecar is a real piece of
infrastructure with its own failure modes. Eventual-consistency story
becomes user-visible (a fact written 30 seconds ago may not yet be in
the graph). RLS does not transit cleanly through ETL — we have to
re-implement user-scoping on the sidecar. Higher cost.

### Option (3) — Standalone Neo4j (Aura or self-hosted)

Purpose-built graph database. Cypher is native, traversals are
optimal, browser visualiser is mature.

**Pros.** Best-in-class for graph queries. Strong tooling. Battle
tested.

**Cons.** Most ops overhead of any option. Separate auth, separate
backup story, separate monitoring. Aura's pricing scales meaningfully
above the Phase-3 Supabase line. Self-hosted adds a cluster to operate.
We end up with three datastores instead of two. Not justified by any
v1 traversal we have evidence we need.

---

## 3. Decision

**We adopt Option (1) — relational graph tables on Supabase — as the
default substrate.**

The substrate ships behind a single migration (`db/migrations/026_kg_v1.sql`)
and is read/written via brain tool routes:

- `lumo_kg_upsert_node(user_id, label, external_key, properties, source)`
- `lumo_kg_upsert_edge(user_id, source_id, target_id, edge_type, properties, source)`
- `lumo_kg_traverse(user_id, start_node_id, edge_filter[], max_hops, max_results)`
- `lumo_kg_path(user_id, source_node_id, target_node_id, max_hops)`
- `lumo_kg_neighbours(user_id, node_id, edge_filter[], top_k)`

All five tools follow the existing brain-tool envelope (timeout,
fallback, audit row in `agent_tool_usage`). Lumo Core owns the SQL —
the brain receives only redacted candidate node ids and never the raw
properties bag.

### Trigger conditions to escalate

The default holds *until* one of these fires in production for a
sustained 7-day window:

- **Hop depth.** P95 of successful KG queries routinely exceeds 3
  hops. ("Routinely" = >5% of weekly KG traffic.)
- **Latency.** P95 KG query latency exceeds 4 seconds end-to-end.
- **CTE complexity.** A new traversal pattern requires a recursive
  CTE longer than 60 lines or a query plan that the planner refuses
  to optimise (visible cost > 1e7 on `EXPLAIN`).

If any of those fire, escalate to **Option (2): Cloud SQL Postgres +
Apache AGE as a graph sidecar.** The migration plan for that
escalation is documented in §10 — schema is portable, edge/node
shapes round-trip into AGE without lossy mapping.

Option (3) Neo4j stays a "last resort if (2) doesn't scale." We do
not plan for it. We write down enough about it to make a future
decision tractable, but we do not build for it.

---

## 4. Schema design

### Node labels (initial set, extensible)

| Label | Source | Example properties |
|---|---|---|
| `contact` | gmail/calendar archive | `name`, `email`, `phone`, `last_seen_at` |
| `mission` | `missions` row | `mission_id`, `state`, `created_at`, `summary` |
| `agent` | `RegistryEntry` | `agent_id`, `name`, `version`, `category` |
| `event` | calendar archive | `title`, `start_at`, `end_at`, `location` |
| `place` | trip planner / calendar | `name`, `address`, `lat`, `lng` |
| `vendor` | marketplace install | `vendor_id`, `name` |
| `document` | PDF/audio archive | `document_id`, `title`, `source_table` |
| `fact` | user_facts ingest | `text`, `confidence` |
| `topic` | NER pass on archive | `name`, `aliases[]` |
| `preference` | preference_events aggregate | `surface`, `candidate_type`, `weight` |

`label` is intentionally a small enum-shaped string, not a full
ontology. We will not over-engineer the label set in v1. New labels
require a one-line ADR addendum; renames require a migration with a
backfill.

### Edge types (initial set, extensible)

| Edge type | Direction | Example |
|---|---|---|
| `mentions` | document/event/message → contact, topic | "this email mentions Alice" |
| `attended` | contact → event | "Bob attended Tuesday's meeting" |
| `located_at` | event/mission → place | "Vegas trip is at Vegas" |
| `executed_by` | mission → agent | "the trip mission used the flight agent" |
| `introduced_by` | contact → contact | "Alice introduced you to Bob" |
| `derived_from` | document/fact → document | "this fact came from this PDF page" |
| `part_of` | event/place/contact → mission | "this hotel is part of the Vegas mission" |
| `related_to` | any → any | catch-all for weaker associations, weight < 0.5 |
| `prefers` | user → candidate | preference-event-derived weight |

Direction matters. Every traversal CTE must specify whether it walks
forward, backward, or undirected. The `graph_edges_user_source` and
`graph_edges_user_target` indexes both exist so either direction is
indexed.

### Provenance (non-negotiable)

Every node and edge row **must** carry `source_table`, `source_row_id`,
and where applicable a `source_url`. A node without provenance is a
bug. The reason is GraphRAG: every traversal hop must be able to
return a citation, and we cannot fabricate citations after the fact.

Provenance is checked in two places:

- A row-insert trigger that rejects inserts where `source_table` is
  null and `label` is not `'fact'`. (Facts can be user-asserted with
  no source — they get `source_table = 'user_assertion'` and
  `source_row_id = '<user_id>'`.)
- The `lumo_kg_traverse` tool refuses to return a path where any hop
  has null provenance. Better to return fewer paths than to return a
  path Lumo cannot defend.

---

## 5. Migration path from existing tables

KG-1 ships in three commits.

### Commit A — schema + service-role RPCs (migration 026)

Tables, indexes, RPCs, RLS policies, no data. Behind
`LUMO_KG_ENABLED=false` in production.

### Commit B — backfill from existing tables (one-shot script)

`scripts/kg_backfill.py` walks Lumo Core sources and emits node/edge
upserts. Sources for v1:

- **Calendar archive (`connector_responses_archive` where
  `agent_id='gmail'` or `agent_id='gcal'`)** → `event` nodes,
  `attended` edges to `contact` nodes (extracted from attendee
  lists), `located_at` edges to `place` nodes (geocoded from event
  location strings, only when the geocoder is configured; otherwise
  the `place` node carries the raw string and `lat/lng = null`).
- **Mission rows (`missions`, `mission_steps`,
  `mission_execution_events`)** → `mission` nodes, `executed_by`
  edges to `agent` nodes, `part_of` edges to `event`/`place` nodes
  for trip-shaped missions.
- **Preference events (`preference_events`)** → aggregated to
  `preference` nodes per user/surface/candidate, with `prefers`
  edges from a synthetic `user` node. Aggregate weekly, not row-by-row.
- **PDF/audio documents (`pdf_documents`, `audio_transcripts`)** →
  `document` nodes, `derived_from` edges from any `fact` extracted
  by the existing classifier path.

The backfill is idempotent — every upsert keys on
`(user_id, label, external_key)` for nodes and
`(user_id, source_id, target_id, edge_type)` for edges. Re-running
the backfill produces zero net writes if data hasn't changed.

Backfill is not full-history. Initial backfill window: last 90 days
of archive data per user. Earlier data is brought in lazily on
demand (when a query traverses to a region of the graph that is
sparse, the on-demand backfill fires for that user/source).

### Commit C — write-through hooks (incremental)

Every write that creates a new edge-relevant row in the source
tables also writes a graph upsert as a best-effort side effect:

- `connector_responses_archive` insert → emit a follow-up indexer
  job that walks the row for entities and writes nodes/edges.
- `missions` insert → write the `mission` node and the static
  edges (executed_by, part_of) immediately.
- `preference_events` insert → batch-aggregate into the weekly
  preference upsert; do not write a row per click.

Write-through is best-effort. If the KG write fails, the source
write still succeeds. The gap is closed by a nightly reconciliation
cron that re-runs the backfill for the last 24h.

---

## 6. Query patterns (recursive CTE templates)

Codex implements these as named SQL functions
(`kg_traverse_one_hop`, `kg_traverse_two_hop`, `kg_traverse_three_hop`,
`kg_path_bounded`) so the brain tools are thin wrappers.

### 1-hop neighbours

```sql
select e.target_id, n.label, n.properties, e.edge_type, e.weight, n.source_url
from public.graph_edges e
join public.graph_nodes n on n.id = e.target_id
where e.user_id = :user_id
  and e.source_id = :start_node_id
  and (:edge_filter is null or e.edge_type = any(:edge_filter))
order by e.weight desc
limit :top_k;
```

### 2-hop traversal with cycle prevention

```sql
with recursive walk as (
  select :start_node_id as node_id, array[:start_node_id] as path, 0 as depth, 1.0::real as score
  union all
  select e.target_id, w.path || e.target_id, w.depth + 1, w.score * e.weight
  from walk w
  join public.graph_edges e
    on e.source_id = w.node_id and e.user_id = :user_id
  where w.depth < 2
    and not e.target_id = any(w.path)              -- cycle guard
    and (:edge_filter is null or e.edge_type = any(:edge_filter))
)
select w.node_id, n.label, n.properties, w.depth, w.score, n.source_url
from walk w
join public.graph_nodes n on n.id = w.node_id
where w.depth > 0
order by w.score desc
limit :max_results;
```

### 3-hop bounded path search

Identical shape with `w.depth < 3` and an additional join to
`graph_nodes` at each level for label-based pruning. Queries above 3
hops trigger the escalation criteria — we hand-write 1, 2, and 3 hop
templates and refuse to add a 4-hop template in v1.

### Bidirectional shortest path (for "how do these two things relate?")

A meet-in-the-middle pattern: walk forward from source for `k/2` hops,
walk backward from target for `k/2` hops, intersect on the
`graph_nodes.id`. Bounded at `k <= 4` total. Documented as a separate
helper because it is the query the marketing team asks for most
("how is the user connected to this contact?").

---

## 7. GraphRAG provenance contract

Every brain response derived from a graph traversal must include:

- An `evidence` array with one entry per hop:
  `{ node_id, label, source_table, source_row_id, source_url, asserted_at }`
- A `path` array of node ids from start to end.
- A `confidence` score derived from the product of edge weights along
  the path, normalised to `[0, 1]`.

The orchestrator surfaces evidence in the chat response as
clickable citations. A response without evidence is rejected by the
client renderer (we will not display a graph-derived answer with no
provenance — that's an attack surface for hallucinated relationships).

---

## 8. Latency and fallbacks

Hot-path budgets:

- `lumo_kg_neighbours` (1-hop): p95 < 200ms.
- `lumo_kg_traverse` (2-hop): p95 < 600ms.
- `lumo_kg_traverse` (3-hop): p95 < 1500ms.
- `lumo_kg_path` (bounded shortest-path, k<=4): p95 < 2000ms.

Fallback rules:

- Brain unreachable / malformed → Core falls back to a flat
  `content_embeddings` top-k vector search and tags the response
  `evidence_mode: 'vector_only'`. The client renders that
  differently from a graph-cited response.
- Query exceeds budget → return partial result with a
  `truncated: true` flag and the partial path so far. Never
  hard-fail a user-facing query on a slow graph traversal.

---

## 9. Privacy, deletion, RLS

- Every row carries `user_id`. RLS policy: a user can read only their
  own rows. Service role can read all rows for cron/backfill.
- A `DELETE FROM profiles WHERE id = :user_id` cascades through
  `graph_nodes.user_id` and `graph_edges.user_id` via FK.
- The user's "delete my data" path in workspace settings hard-deletes
  KG rows, not soft-deletes. KG provenance is preserved only for
  cited responses already returned to the user; we do not retain
  graph rows past the user's deletion window.
- Cross-user edges are forbidden. Even when two users share a
  contact, they get two separate `contact` nodes (one in each user's
  graph). Federation across users is a Phase-5+ decision; v1 keeps
  per-user graphs strictly disjoint.

---

## 10. Escalation plan to Option (2) Cloud SQL + AGE

If the trigger conditions in §3 fire, the migration is:

1. Stand up Cloud SQL Postgres (smallest viable tier; we expect KG
   reads >> writes).
2. Install Apache AGE via the Cloud SQL extension catalog.
3. ETL `graph_nodes` and `graph_edges` to AGE-shaped vertices and
   edges nightly. The schemas already match: AGE vertices take a
   label and a JSON properties bag, our nodes already have both.
4. Brain tools gain a `query_engine` switch
   (`'cte' | 'cypher'`) — falls back to CTE on Supabase if the
   sidecar is degraded. The default flips to `'cypher'` once the
   sidecar is healthy for 7 days.
5. Mutations stay on Supabase (Postgres of record). The sidecar is
   read-only. We accept the eventual-consistency window (target:
   p95 < 5 minutes) explicitly.

Estimated effort to escalate: 2 sprints (schema port, ETL,
brain-tool switch, ops). We document this as a *contingency*, not a
plan-of-record. The point of writing it down is that nobody has to
re-do the analysis if the trigger fires.

---

## 11. Acceptance criteria for KG-1

KG-1 ships when:

1. Migration 026 is applied to preview and production. RLS is
   verified by a test that asserts user A cannot read user B's
   nodes.
2. `scripts/kg_backfill.py` runs over the Vegas test user and
   produces at minimum: 1 mission node, 5 event nodes, 3 contact
   nodes, 2 place nodes, 10 derived edges. All carry provenance.
3. The five brain tools are live on the Cloud Run service with
   the documented latency budgets. CI gates p95 from a synthetic
   workload.
4. Chat orchestrator surfaces a graph-cited answer to "who did I
   meet with about the Vegas trip last month" with at least two
   evidence rows. The answer renders citations the user can click.
5. Write-through hooks for `missions` and `connector_responses_archive`
   are live and the nightly reconciliation cron is green for 7
   consecutive days.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Recursive CTE perf degrades as graph grows | Hard cap on hop depth; HNSW index on node embeddings; weekly query-plan review during Phase 4 |
| Backfill blows up Postgres CPU | Row-cap per backfill batch (2k nodes / 5k edges); off-hours cron; circuit breaker on Cloud Run |
| Graph drift vs. source tables | Nightly reconciliation cron; `kg_drift_report` admin surface |
| Privacy leak through cross-user edge | Forbidden by schema (no cross-user edges) + RLS test in CI |
| AGE-on-Supabase becomes available later | Re-evaluate at the next phase ADR; do not pre-commit |
| Graph-cited answer hallucination | Provenance contract enforced server-side; client refuses to render graph answers without evidence |
| Embedding-cued traversal cost | `embedding` column is nullable; only populated for nodes with text content; index is partial |

---

## 13. Open questions

1. Do we want to expose a debug `/admin/kg/<user_id>` graph
   visualiser (read-only D3 force layout)? Recommended yes for ops,
   but not on the v1 ship list — admin gets a tabular surface in v1.
2. How do we handle the "user changed their mind" case where a fact
   asserted by a connector is later corrected? v1 keeps both with
   `asserted_at` ordering and the most recent wins on read; v2 may
   add a `superseded_by` edge. Document this as a Phase-4 follow-up.
3. Should `preference` nodes age out? v1 keeps them indefinitely
   with weight decay applied at read time. v2 may run a nightly
   prune.

---

## 14. Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | Adopt Option (1) Supabase relational graph tables as the v1 substrate |
| 2026-04-27 | Hard-close Apache-AGE-on-Supabase as a v1 path; verified against Supabase's supported extension list |
| 2026-04-27 | Lock the provenance contract: every node/edge carries source_table/source_row_id/source_url; no anonymous graph rows |
| 2026-04-27 | Cap v1 hop depth at 3; queries beyond 3 hops trigger escalation, not a deeper template |
| 2026-04-27 | Document Cloud SQL + AGE as the *named* escalation; leave Neo4j as last-resort only |
| 2026-04-27 | Per-user graphs strictly disjoint; cross-user edges forbidden in v1 |
