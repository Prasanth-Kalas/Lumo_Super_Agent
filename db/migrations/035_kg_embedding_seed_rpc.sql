-- Migration 035 — KG-1.2 embedding seed selection.
--
-- Adds the service-role RPC used by GraphRAG recall to select seed nodes by
-- cosine similarity instead of full-table reads. It also extends
-- lumo_kg_upsert_node with an optional embedding argument so synthetic and
-- future ETL rebuilds can idempotently backfill graph node embeddings.
--
-- Rollback:
--   drop function if exists public.lumo_kg_seed_by_embedding(uuid, vector, integer);
--   drop function if exists public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb, vector);
--   -- Re-apply migration 028's five-argument lumo_kg_upsert_node definition if rolling back.

drop function if exists public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb);

create or replace function public.lumo_kg_upsert_node(
  p_user_id uuid,
  p_label text,
  p_external_key text,
  p_properties jsonb default '{}'::jsonb,
  p_source jsonb default '{}'::jsonb,
  p_embedding vector(384) default null
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
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  insert into public.graph_nodes (
    user_id,
    label,
    external_key,
    properties,
    embedding,
    source_table,
    source_row_id,
    source_url,
    asserted_at
  )
  values (
    p_user_id,
    lower(p_label),
    p_external_key,
    coalesce(p_properties, '{}'::jsonb),
    p_embedding,
    source_table,
    source_row_id,
    source_url,
    now()
  )
  on conflict (user_id, label, external_key)
  do update set
    properties = public.graph_nodes.properties || excluded.properties,
    embedding = coalesce(excluded.embedding, public.graph_nodes.embedding),
    source_table = excluded.source_table,
    source_row_id = excluded.source_row_id,
    source_url = excluded.source_url,
    asserted_at = now()
  returning id into inserted_id;

  return inserted_id;
end;
$$;

create or replace function public.lumo_kg_seed_by_embedding(
  p_user_id uuid,
  p_query_embedding vector(384),
  p_k integer default 5
)
returns table (
  node_id uuid,
  label text,
  properties jsonb,
  score real,
  source_table text,
  source_row_id text,
  source_url text,
  asserted_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    n.id as node_id,
    n.label,
    n.properties,
    greatest(0, least(1, 1 - (n.embedding <=> p_query_embedding)))::real as score,
    n.source_table,
    n.source_row_id,
    n.source_url,
    n.asserted_at
  from public.graph_nodes n
  where
    auth.role() = 'service_role'
    and n.user_id = p_user_id
    and n.embedding is not null
    and n.source_table is not null
    and n.source_row_id is not null
  order by n.embedding <=> p_query_embedding, n.id
  limit greatest(1, least(coalesce(p_k, 5), 20));
$$;

comment on function public.lumo_kg_traverse(uuid, uuid, text[], integer, integer)
  is 'KG-1 traversal is intentionally capped to three hops inside the function per ADR-008 latency budget.';

revoke all on function public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb, vector) from public;
revoke all on function public.lumo_kg_seed_by_embedding(uuid, vector, integer) from public;
revoke all on function public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb, vector) from anon, authenticated;
revoke all on function public.lumo_kg_seed_by_embedding(uuid, vector, integer) from anon, authenticated;

grant execute on function public.lumo_kg_upsert_node(uuid, text, text, jsonb, jsonb, vector) to service_role;
grant execute on function public.lumo_kg_seed_by_embedding(uuid, vector, integer) to service_role;
