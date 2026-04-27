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
--   drop function if exists public.lumo_kg_upsert_edge(uuid, uuid, uuid, text, jsonb, jsonb, real);
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

-- Provenance trigger (ADR-008 §4 "non-negotiable"): a node without
-- source_table is a bug, except when the label is 'fact' (user-asserted
-- facts get source_table='user_assertion'). The same trigger also blocks
-- cross-user graph_edges so a direct table write cannot bypass the RPC.
create or replace function public.graph_require_provenance()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  source_user uuid;
  target_user uuid;
begin
  if (tg_table_name = 'graph_nodes') then
    if new.source_table is null and lower(new.label) = 'fact' then
      new.source_table := 'user_assertion';
    end if;
    if new.source_row_id is null and lower(new.label) = 'fact' then
      new.source_row_id := coalesce(new.external_key, new.id::text);
    end if;
    if new.source_table is null or new.source_row_id is null then
      raise exception 'graph_nodes row missing provenance (source_table is null)';
    end if;
    new.updated_at := now();
  elsif (tg_table_name = 'graph_edges') then
    if new.source_table is null or new.source_row_id is null then
      raise exception 'graph_edges row missing provenance (source_table is null)';
    end if;
    select s.user_id, t.user_id
      into source_user, target_user
    from public.graph_nodes s
    join public.graph_nodes t on t.id = new.target_id
    where s.id = new.source_id;

    if source_user is null or target_user is null then
      raise exception 'graph_edges row references unknown graph_nodes';
    end if;
    if source_user <> new.user_id or target_user <> new.user_id then
      raise exception 'cross-user graph_edges are forbidden';
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

create or replace function public.lumo_kg_upsert_node(
  p_user_id uuid,
  p_label text,
  p_external_key text,
  p_properties jsonb default '{}'::jsonb,
  p_source jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  source_table text := nullif(p_source ->> 'source_table', '');
  source_row_id text := nullif(p_source ->> 'source_row_id', '');
  source_url text := nullif(p_source ->> 'source_url', '');
begin
  if p_user_id is null then
    raise exception 'lumo_kg_upsert_node requires user_id';
  end if;
  if nullif(p_label, '') is null then
    raise exception 'lumo_kg_upsert_node requires label';
  end if;
  if nullif(p_external_key, '') is null then
    raise exception 'lumo_kg_upsert_node requires external_key';
  end if;

  if source_table is null and lower(p_label) = 'fact' then
    source_table := 'user_assertion';
  end if;
  if source_row_id is null and lower(p_label) = 'fact' then
    source_row_id := p_external_key;
  end if;
  if source_table is null or source_row_id is null then
    raise exception 'lumo_kg_upsert_node requires source_table and source_row_id';
  end if;

  insert into public.graph_nodes (
    user_id,
    label,
    external_key,
    properties,
    source_table,
    source_row_id,
    source_url
  )
  values (
    p_user_id,
    lower(p_label),
    p_external_key,
    coalesce(p_properties, '{}'::jsonb),
    source_table,
    source_row_id,
    source_url
  )
  on conflict (user_id, label, external_key)
  do update set
    properties = public.graph_nodes.properties || excluded.properties,
    source_table = excluded.source_table,
    source_row_id = excluded.source_row_id,
    source_url = excluded.source_url,
    asserted_at = now(),
    updated_at = now()
  returning id into inserted_id;

  return inserted_id;
end;
$$;

create or replace function public.lumo_kg_upsert_edge(
  p_user_id uuid,
  p_source_id uuid,
  p_target_id uuid,
  p_edge_type text,
  p_properties jsonb default '{}'::jsonb,
  p_source jsonb default '{}'::jsonb,
  p_weight real default 1.0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  source_table text := nullif(p_source ->> 'source_table', '');
  source_row_id text := nullif(p_source ->> 'source_row_id', '');
  source_url text := nullif(p_source ->> 'source_url', '');
begin
  if p_user_id is null then
    raise exception 'lumo_kg_upsert_edge requires user_id';
  end if;
  if p_source_id is null or p_target_id is null then
    raise exception 'lumo_kg_upsert_edge requires source_id and target_id';
  end if;
  if nullif(p_edge_type, '') is null then
    raise exception 'lumo_kg_upsert_edge requires edge_type';
  end if;
  if source_table is null or source_row_id is null then
    raise exception 'lumo_kg_upsert_edge requires source_table and source_row_id';
  end if;

  insert into public.graph_edges (
    user_id,
    source_id,
    target_id,
    edge_type,
    properties,
    weight,
    source_table,
    source_row_id,
    source_url
  )
  values (
    p_user_id,
    p_source_id,
    p_target_id,
    upper(p_edge_type),
    coalesce(p_properties, '{}'::jsonb),
    greatest(0.0, least(coalesce(p_weight, 1.0), 1.0)),
    source_table,
    source_row_id,
    source_url
  )
  on conflict (user_id, source_id, target_id, edge_type)
  do update set
    properties = public.graph_edges.properties || excluded.properties,
    weight = excluded.weight,
    source_table = excluded.source_table,
    source_row_id = excluded.source_row_id,
    source_url = excluded.source_url,
    asserted_at = now()
  returning id into inserted_id;

  return inserted_id;
end;
$$;

create or replace function public.lumo_kg_traverse(
  p_user_id uuid,
  p_start_node_id uuid,
  p_edge_filter text[] default null,
  p_max_hops integer default 3,
  p_max_results integer default 50
)
returns table (
  node_id uuid,
  label text,
  properties jsonb,
  depth integer,
  score real,
  path uuid[],
  edge_types text[],
  evidence jsonb
)
language sql
security definer
set search_path = public
as $$
  with recursive walk as (
    select
      n.id as node_id,
      n.label,
      n.properties,
      0::integer as depth,
      1.0::real as score,
      array[n.id]::uuid[] as path,
      array[]::text[] as edge_types,
      jsonb_build_array(
        jsonb_build_object(
          'kind', 'node',
          'node_id', n.id,
          'label', n.label,
          'source_table', n.source_table,
          'source_row_id', n.source_row_id,
          'source_url', n.source_url,
          'asserted_at', n.asserted_at
        )
      ) as evidence
    from public.graph_nodes n
    where
      n.user_id = p_user_id
      and n.id = p_start_node_id
      and n.source_table is not null
      and n.source_row_id is not null

    union all

    select
      target.id as node_id,
      target.label,
      target.properties,
      walk.depth + 1 as depth,
      (walk.score * edge.weight)::real as score,
      walk.path || target.id,
      walk.edge_types || edge.edge_type,
      walk.evidence ||
        jsonb_build_array(
          jsonb_build_object(
            'kind', 'edge',
            'edge_id', edge.id,
            'edge_type', edge.edge_type,
            'source_table', edge.source_table,
            'source_row_id', edge.source_row_id,
            'source_url', edge.source_url,
            'asserted_at', edge.asserted_at
          ),
          jsonb_build_object(
            'kind', 'node',
            'node_id', target.id,
            'label', target.label,
            'source_table', target.source_table,
            'source_row_id', target.source_row_id,
            'source_url', target.source_url,
            'asserted_at', target.asserted_at
          )
        )
    from walk
    join public.graph_edges edge
      on edge.user_id = p_user_id
      and edge.source_id = walk.node_id
    join public.graph_nodes target
      on target.user_id = p_user_id
      and target.id = edge.target_id
    where
      walk.depth < greatest(1, least(coalesce(p_max_hops, 3), 3))
      and (
        coalesce(array_length(p_edge_filter, 1), 0) = 0
        or edge.edge_type = any(p_edge_filter)
        or lower(edge.edge_type) = any(p_edge_filter)
      )
      and not target.id = any(walk.path)
      and edge.source_table is not null
      and edge.source_row_id is not null
      and target.source_table is not null
      and target.source_row_id is not null
  )
  select
    walk.node_id,
    walk.label,
    walk.properties,
    walk.depth,
    walk.score,
    walk.path,
    walk.edge_types,
    walk.evidence
  from walk
  where walk.depth > 0
  order by walk.depth asc, walk.score desc, walk.node_id asc
  limit greatest(1, least(coalesce(p_max_results, 50), 100));
$$;

create or replace function public.lumo_kg_path(
  p_user_id uuid,
  p_source_node_id uuid,
  p_target_node_id uuid,
  p_max_hops integer default 3
)
returns table (
  node_id uuid,
  label text,
  properties jsonb,
  depth integer,
  score real,
  path uuid[],
  edge_types text[],
  evidence jsonb
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.lumo_kg_traverse(
    p_user_id,
    p_source_node_id,
    null,
    greatest(1, least(coalesce(p_max_hops, 3), 3)),
    100
  ) candidate
  where candidate.node_id = p_target_node_id
  order by candidate.depth asc, candidate.score desc
  limit 1;
$$;

create or replace function public.lumo_kg_neighbours(
  p_user_id uuid,
  p_start_node_id uuid,
  p_edge_filter text[] default null,
  p_max_results integer default 50
)
returns table (
  node_id uuid,
  label text,
  properties jsonb,
  depth integer,
  score real,
  path uuid[],
  edge_types text[],
  evidence jsonb
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.lumo_kg_traverse(p_user_id, p_start_node_id, p_edge_filter, 1, p_max_results);
$$;

create or replace function public.kg_traverse_one_hop(
  p_user_id uuid,
  p_start_node_id uuid,
  p_edge_filter text[] default null,
  p_max_results integer default 50
)
returns table (
  node_id uuid,
  label text,
  properties jsonb,
  depth integer,
  score real,
  path uuid[],
  edge_types text[],
  evidence jsonb
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.lumo_kg_traverse(p_user_id, p_start_node_id, p_edge_filter, 1, p_max_results);
$$;

create or replace function public.kg_traverse_two_hop(
  p_user_id uuid,
  p_start_node_id uuid,
  p_edge_filter text[] default null,
  p_max_results integer default 50
)
returns table (
  node_id uuid,
  label text,
  properties jsonb,
  depth integer,
  score real,
  path uuid[],
  edge_types text[],
  evidence jsonb
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.lumo_kg_traverse(p_user_id, p_start_node_id, p_edge_filter, 2, p_max_results);
$$;

create or replace function public.kg_traverse_three_hop(
  p_user_id uuid,
  p_start_node_id uuid,
  p_edge_filter text[] default null,
  p_max_results integer default 50
)
returns table (
  node_id uuid,
  label text,
  properties jsonb,
  depth integer,
  score real,
  path uuid[],
  edge_types text[],
  evidence jsonb
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.lumo_kg_traverse(p_user_id, p_start_node_id, p_edge_filter, 3, p_max_results);
$$;

create or replace function public.kg_path_bounded(
  p_user_id uuid,
  p_source_node_id uuid,
  p_target_node_id uuid,
  p_max_hops integer default 3
)
returns table (
  node_id uuid,
  label text,
  properties jsonb,
  depth integer,
  score real,
  path uuid[],
  edge_types text[],
  evidence jsonb
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.lumo_kg_path(p_user_id, p_source_node_id, p_target_node_id, p_max_hops);
$$;

revoke all on function public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb) from public;
revoke all on function public.lumo_kg_upsert_edge(uuid, uuid, uuid, text, jsonb, jsonb, real) from public;
revoke all on function public.lumo_kg_traverse(uuid, uuid, text[], integer, integer) from public;
revoke all on function public.lumo_kg_path(uuid, uuid, uuid, integer) from public;
revoke all on function public.lumo_kg_neighbours(uuid, uuid, text[], integer) from public;
revoke all on function public.kg_traverse_one_hop(uuid, uuid, text[], integer) from public;
revoke all on function public.kg_traverse_two_hop(uuid, uuid, text[], integer) from public;
revoke all on function public.kg_traverse_three_hop(uuid, uuid, text[], integer) from public;
revoke all on function public.kg_path_bounded(uuid, uuid, uuid, integer) from public;

revoke all on function public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb) from anon, authenticated;
revoke all on function public.lumo_kg_upsert_edge(uuid, uuid, uuid, text, jsonb, jsonb, real) from anon, authenticated;
revoke all on function public.lumo_kg_traverse(uuid, uuid, text[], integer, integer) from anon, authenticated;
revoke all on function public.lumo_kg_path(uuid, uuid, uuid, integer) from anon, authenticated;
revoke all on function public.lumo_kg_neighbours(uuid, uuid, text[], integer) from anon, authenticated;
revoke all on function public.kg_traverse_one_hop(uuid, uuid, text[], integer) from anon, authenticated;
revoke all on function public.kg_traverse_two_hop(uuid, uuid, text[], integer) from anon, authenticated;
revoke all on function public.kg_traverse_three_hop(uuid, uuid, text[], integer) from anon, authenticated;
revoke all on function public.kg_path_bounded(uuid, uuid, uuid, integer) from anon, authenticated;

grant execute on function public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.lumo_kg_upsert_edge(uuid, uuid, uuid, text, jsonb, jsonb, real) to service_role;
grant execute on function public.lumo_kg_traverse(uuid, uuid, text[], integer, integer) to service_role;
grant execute on function public.lumo_kg_path(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.lumo_kg_neighbours(uuid, uuid, text[], integer) to service_role;
grant execute on function public.kg_traverse_one_hop(uuid, uuid, text[], integer) to service_role;
grant execute on function public.kg_traverse_two_hop(uuid, uuid, text[], integer) to service_role;
grant execute on function public.kg_traverse_three_hop(uuid, uuid, text[], integer) to service_role;
grant execute on function public.kg_path_bounded(uuid, uuid, uuid, integer) to service_role;
