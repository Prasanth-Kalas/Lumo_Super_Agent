-- Migration 016 — Day 6 Intelligence Layer archive recall.
--
-- Adds a service-role-only vector search RPC over the redacted
-- content_embeddings table. Lumo Core calls this first, then sends the
-- bounded candidate set to Lumo_ML_Service /recall for lightweight reranking.
--
-- Rollback:
--   drop function if exists public.match_content_embeddings(uuid, vector(384), integer, text[]);

create or replace function public.match_content_embeddings(
  target_user uuid,
  query_embedding vector(384),
  match_count integer default 12,
  source_agent_ids text[] default null
)
returns table (
  id uuid,
  source_table text,
  source_row_id bigint,
  source_etag text,
  chunk_index integer,
  source_agent_id text,
  endpoint text,
  content_hash text,
  text text,
  metadata jsonb,
  score double precision,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    e.id,
    e.source_table,
    e.source_row_id,
    e.source_etag,
    e.chunk_index,
    e.source_agent_id,
    e.endpoint,
    e.content_hash,
    e.text,
    e.metadata,
    greatest(0, least(1, 1 - (e.embedding <=> query_embedding))) as score,
    e.created_at
  from public.content_embeddings e
  where
    e.user_id = target_user
    and (
      source_agent_ids is null
      or cardinality(source_agent_ids) = 0
      or e.source_agent_id = any(source_agent_ids)
    )
  order by e.embedding <=> query_embedding, e.created_at desc
  limit greatest(1, least(coalesce(match_count, 12), 50));
$$;

revoke all on function public.match_content_embeddings(uuid, vector(384), integer, text[]) from public;
grant execute on function public.match_content_embeddings(uuid, vector(384), integer, text[]) to service_role;
