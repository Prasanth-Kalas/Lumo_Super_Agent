-- Migration 015 — Day 3 Intelligence Layer archive embeddings.
--
-- Lumo Core owns the indexer cron over connector_responses_archive; the
-- Lumo_ML_Service remains a stateless system-agent tool that only embeds
-- redacted text chunks. This table stores the resulting vectors for recall
-- and marketplace intelligence without mixing 384-dim ML-service embeddings
-- into the existing 1536-dim user_facts memory table.
--
-- Rollback, if this migration must be backed out before production data is
-- relied on:
--   drop function if exists public.next_connector_archive_embedding_batch(integer);
--   drop table if exists public.content_embedding_sources;
--   drop table if exists public.content_embeddings;

create extension if not exists vector;

create table if not exists public.content_embeddings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  source_table      text not null,
  source_row_id     bigint not null,
  source_etag       text not null,
  chunk_index       integer not null check (chunk_index >= 0),
  source_agent_id   text,
  endpoint          text,
  request_hash      text,
  content_hash      text not null,
  text              text not null,
  metadata          jsonb not null default '{}'::jsonb,
  embedding         vector(384) not null,
  model             text not null,
  dimensions        integer not null default 384 check (dimensions = 384),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_table, source_row_id, source_etag, chunk_index)
);

create index if not exists content_embeddings_by_user_recent
  on public.content_embeddings (user_id, created_at desc);

create index if not exists content_embeddings_by_source
  on public.content_embeddings (source_table, source_row_id, source_etag);

create index if not exists content_embeddings_by_agent_endpoint
  on public.content_embeddings (user_id, source_agent_id, endpoint, created_at desc);

create index if not exists content_embeddings_vector_cosine
  on public.content_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

drop trigger if exists content_embeddings_touch_updated_at on public.content_embeddings;
create trigger content_embeddings_touch_updated_at
  before update on public.content_embeddings
  for each row execute function public.touch_updated_at();

-- One row per indexed archive source row. This is intentionally separate
-- from content_embeddings because some archive rows have no useful text; we
-- still need to mark them as processed so every cron run does not retry them.
create table if not exists public.content_embedding_sources (
  source_table    text not null,
  source_row_id   bigint not null,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  source_agent_id text,
  endpoint        text,
  source_etag     text not null,
  status          text not null check (status in ('embedded', 'no_text', 'failed')),
  chunk_count     integer not null default 0 check (chunk_count >= 0),
  last_error      text,
  indexed_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (source_table, source_row_id)
);

create index if not exists content_embedding_sources_retry
  on public.content_embedding_sources (status, updated_at)
  where status = 'failed';

create index if not exists content_embedding_sources_by_user
  on public.content_embedding_sources (user_id, indexed_at desc);

create index if not exists content_embedding_sources_by_agent
  on public.content_embedding_sources (user_id, source_agent_id, endpoint);

drop trigger if exists content_embedding_sources_touch_updated_at on public.content_embedding_sources;
create trigger content_embedding_sources_touch_updated_at
  before update on public.content_embedding_sources
  for each row execute function public.touch_updated_at();

create or replace function public.next_connector_archive_embedding_batch(
  requested_limit integer default 100
)
returns table (
  id bigint,
  user_id uuid,
  agent_id text,
  external_account_id text,
  endpoint text,
  request_hash text,
  response_status integer,
  response_body jsonb,
  fetched_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    a.id,
    a.user_id,
    a.agent_id,
    a.external_account_id,
    a.endpoint,
    a.request_hash,
    a.response_status,
    a.response_body,
    a.fetched_at
  from public.connector_responses_archive a
  left join public.content_embedding_sources s
    on s.source_table = 'connector_responses_archive'
   and s.source_row_id = a.id
  where
    s.source_row_id is null
    or (
      s.status = 'failed'
      and s.updated_at < now() - interval '1 hour'
    )
  order by a.fetched_at desc, a.id desc
  limit greatest(1, least(coalesce(requested_limit, 100), 500));
$$;

revoke all on function public.next_connector_archive_embedding_batch(integer) from public;
grant execute on function public.next_connector_archive_embedding_batch(integer) to service_role;
