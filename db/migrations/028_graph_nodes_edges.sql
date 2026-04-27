-- Migration 028 — KG-1 knowledge graph substrate.
--
-- Codex fills the body for KG-1. This file is the scaffold: graph_nodes and
-- graph_edges tables plus indexes per ADR-008 §2 Option (1), with RLS, and
-- the provenance trigger that ADR-008 §4 makes non-negotiable. Codex adds the
-- five service-role RPCs (lumo_kg_upsert_node / upsert_edge / traverse / path
-- / neighbours) and the recursive-CTE traversal helpers (kg_traverse_one_hop,
-- kg_traverse_two_hop, kg_traverse_three_hop, kg_path_bounded) directly under
-- this scaffold once schema is approved.
--
-- Related:
--   - docs/specs/adr-008-knowledge-graph-substrate.md (sealed)
--   - docs/specs/phase-3-master.md §2 (KG-1 deliverable)
--   - tests/phase3-knowledge-graph.test.mjs
--   - tests/phase3-graph-rag-recall.test.mjs
--   - scripts/kg_backfill.py (Codex writes; backfill 90d archive per user)
--
-- Open schema decisions escalated to Kalas:
--   - Whether to add ltree hierarchy_path now (ADR-008 §2 lists it). Scaffold
--     includes it as optional/nullable to leave the option open.
--   - Whether `embedding` should be 384 (text MiniLM) or 1024 (unified MMRAG-1
--     space). ADR-008 §2 specifies 384; left as 384 here. Confirm before merge.
--
-- Rollback:
--   drop function if exists public.kg_path_bounded(uuid, uuid, uuid, integer);
--   drop function if exists public.kg_traverse_three_hop(uuid, uuid, text[], integer);
--   drop function if exists public.kg_traverse_two_hop(uuid, uuid, text[], integer);
--   drop function if exists public.kg_traverse_one_hop(uuid, uuid, text[], integer);
--   drop function if exists public.lumo_kg_neighbours(uuid, uuid, text[], integer);
--   drop function if exists public.lumo_kg_path(uuid, uuid, uuid, integer);
--   drop function if exists public.lumo_kg_traverse(uuid, uuid, text[], integer, integer);
--   drop function if exists public.lumo_kg_upsert_edge(uuid, uuid, uuid, text, jsonb, jsonb);
--   drop function if exists public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb);
--   drop trigger  if exists graph_nodes_require_provenance on public.graph_nodes;
--   drop trigger  if exists graph_edges_require_provenance on public.graph_edges;
--   drop function if exists public.graph_require_provenance();
--   drop index    if exists public.graph_edges_user_target;
--   drop index    if exists public.graph_edges_user_source;
--   drop index    if exists public.graph_edges_properties_gin;
--   drop index    if exists public.graph_edges_edge_type;
--   drop index    if exists public.graph_nodes_hierarchy;
--   drop index    if exists public.graph_nodes_embedding_hnsw;
--   drop index    if exists public.graph_nodes_user_extkey;
--   drop index    if exists public.graph_nodes_user_label;
--   drop index    if exists public.graph_nodes_properties_gin;
--   drop table    if exists public.graph_edges;
--   drop table    if exists public.graph_nodes;

create extension if not exists vector;
create extension if not exists ltree;

create table if not exists public.graph_nodes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  label           text not null,
  external_key    text,
  properties      jsonb not null default '{}'::jsonb,
  embedding       vector(384),
  hierarchy_path  ltree,
  source_table    text,
  source_row_id   text,
  source_url      text,
  asserted_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, label, external_key)
);

create table if not exists public.graph_edges (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  source_id       uuid not null references public.graph_nodes(id) on delete cascade,
  target_id       uuid not null references public.graph_nodes(id) on delete cascade,
  edge_type       text not null,
  properties      jsonb not null default '{}'::jsonb,
  weight          real not null default 1.0,
  source_table    text,
  source_row_id   text,
  source_url      text,
  asserted_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (user_id, source_id, target_id, edge_type)
);

create index if not exists graph_nodes_user_label
  on public.graph_nodes (user_id, label);

create index if not exists graph_nodes_user_extkey
  on public.graph_nodes (user_id, label, external_key);

create index if not exists graph_nodes_properties_gin
  on public.graph_nodes using gin (properties);

create index if not exists graph_nodes_embedding_hnsw
  on public.graph_nodes using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

create index if not exists graph_nodes_hierarchy
  on public.graph_nodes using gist (hierarchy_path)
  where hierarchy_path is not null;

create index if not exists graph_edges_user_source
  on public.graph_edges (user_id, source_id, edge_type);

create index if not exists graph_edges_user_target
  on public.graph_edges (user_id, target_id, edge_type);

create index if not exists graph_edges_edge_type
  on public.graph_edges (edge_type);

create index if not exists graph_edges_properties_gin
  on public.graph_edges using gin (properties);

-- Cross-user edge guard (ADR-008 §9): forbid edges that span two users.
alter table public.graph_edges
  drop constraint if exists graph_edges_no_cross_user;
-- Codex enforces user_id consistency in the upsert RPC; the constraint
-- below is the belt-and-braces server-side check. Documented but not yet
-- enabled — the trigger form is more readable; Codex picks one before merge.

-- Provenance trigger (ADR-008 §4 "non-negotiable"): a node without
-- source_table is a bug, except when the label is 'fact' (user-asserted
-- facts get source_table='user_assertion').
create or replace function public.graph_require_provenance()
returns trigger
language plpgsql
as $$
begin
  if (tg_table_name = 'graph_nodes') then
    if new.source_table is null and new.label <> 'fact' then
      raise exception 'graph_nodes row missing provenance (source_table is null)';
    end if;
  elsif (tg_table_name = 'graph_edges') then
    if new.source_table is null then
      raise exception 'graph_edges row missing provenance (source_table is null)';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists graph_nodes_require_provenance on public.graph_nodes;
create trigger graph_nodes_require_provenance
  before insert or update on public.graph_nodes
  for each row execute function public.graph_require_provenance();

drop trigger if exists graph_edges_require_provenance on public.graph_edges;
create trigger graph_edges_require_provenance
  before insert or update on public.graph_edges
  for each row execute function public.graph_require_provenance();

alter table public.graph_nodes enable row level security;
revoke all on public.graph_nodes from anon, authenticated;
grant all on public.graph_nodes to service_role;

alter table public.graph_edges enable row level security;
revoke all on public.graph_edges from anon, authenticated;
grant all on public.graph_edges to service_role;

-- Codex fills:
--   create or replace function public.lumo_kg_upsert_node(...)
--   create or replace function public.lumo_kg_upsert_edge(...)
--   create or replace function public.lumo_kg_traverse(...)
--   create or replace function public.lumo_kg_path(...)
--   create or replace function public.lumo_kg_neighbours(...)
--   create or replace function public.kg_traverse_one_hop(...)
--   create or replace function public.kg_traverse_two_hop(...)
--   create or replace function public.kg_traverse_three_hop(...)
--   create or replace function public.kg_path_bounded(...)
-- All security definer, search_path=public, service_role-only execute.
