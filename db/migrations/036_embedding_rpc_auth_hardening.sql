-- Migration 036: Embedding RPC auth hardening.
--
-- Removes brittle `auth.role() = 'service_role'` predicates from batch-claim
-- RPCs whose service-role gating is already enforced by the GRANT EXECUTE
-- boundary. Same root cause as migrations 026 and 035. See the post-mortem in
-- migration 026. Symptom: cron returns zero rows when auth.role() is NULL on
-- pooler connections, so the pipeline silently no-ops.
--
-- RPCs touched:
--   - next_audio_transcript_embedding_batch  (originally 017)
--   - next_pdf_document_embedding_batch      (originally 019)
--   - next_image_embedding_text_batch        (originally 020)
--   - next_rollback_step_for_execution       (originally 025; same active trap)
--
-- Rollback:
--   Re-run the original function definitions from migrations 017, 019, 020,
--   and 025. This is not recommended unless debugging a regression: the
--   GRANT/REVOKE boundary is the durable authorization control.

create or replace function public.next_audio_transcript_embedding_batch(
  requested_limit integer default 100
)
returns table (
  id bigint,
  user_id uuid,
  audio_upload_id text,
  storage_path text,
  transcript text,
  segments jsonb,
  language text,
  duration_s numeric,
  model text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    t.id,
    t.user_id,
    t.audio_upload_id,
    t.storage_path,
    t.transcript,
    t.segments,
    t.language,
    t.duration_s,
    t.model,
    t.created_at
  from public.audio_transcripts t
  left join public.content_embedding_sources s
    on s.source_table = 'audio_transcripts'
   and s.source_row_id = t.id
  where
    (
      s.source_row_id is null
      or (
        s.status = 'failed'
        and s.updated_at < now() - interval '1 hour'
      )
    )
  order by t.created_at desc, t.id desc
  limit greatest(1, least(coalesce(requested_limit, 100), 500));
$$;

revoke execute on function public.next_audio_transcript_embedding_batch(integer) from public, anon, authenticated;
grant execute on function public.next_audio_transcript_embedding_batch(integer) to service_role;

create or replace function public.next_pdf_document_embedding_batch(
  requested_limit integer default 100
)
returns table (
  id bigint,
  user_id uuid,
  document_asset_id text,
  storage_path text,
  filename text,
  pages jsonb,
  total_pages integer,
  language text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    d.id,
    d.user_id,
    d.document_asset_id,
    d.storage_path,
    d.filename,
    d.pages,
    d.total_pages,
    d.language,
    d.created_at
  from public.pdf_documents d
  left join public.content_embedding_sources s
    on s.source_table = 'pdf_documents'
   and s.source_row_id = d.id
  where
    (
      s.source_row_id is null
      or (
        s.status = 'failed'
        and s.updated_at < now() - interval '1 hour'
      )
    )
  order by d.created_at desc, d.id desc
  limit greatest(1, least(coalesce(requested_limit, 100), 500));
$$;

revoke execute on function public.next_pdf_document_embedding_batch(integer) from public, anon, authenticated;
grant execute on function public.next_pdf_document_embedding_batch(integer) to service_role;

create or replace function public.next_image_embedding_text_batch(
  requested_limit integer default 100
)
returns table (
  id bigint,
  user_id uuid,
  image_asset_id text,
  storage_path text,
  filename text,
  mime_type text,
  model text,
  dimensions integer,
  labels jsonb,
  summary_text text,
  content_hash text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    e.id,
    e.user_id,
    e.image_asset_id,
    e.storage_path,
    e.filename,
    e.mime_type,
    e.model,
    e.dimensions,
    e.labels,
    e.summary_text,
    e.content_hash,
    e.created_at
  from public.image_embeddings e
  left join public.content_embedding_sources s
    on s.source_table = 'image_embeddings'
   and s.source_row_id = e.id
  where
    (
      s.source_row_id is null
      or (
        s.status = 'failed'
        and s.updated_at < now() - interval '1 hour'
      )
    )
  order by e.created_at desc, e.id desc
  limit greatest(1, least(coalesce(requested_limit, 100), 500));
$$;

revoke execute on function public.next_image_embedding_text_batch(integer) from public, anon, authenticated;
grant execute on function public.next_image_embedding_text_batch(integer) to service_role;

create or replace function public.next_rollback_step_for_execution(
  requested_limit integer default 10
)
returns table (
  id uuid,
  mission_id uuid,
  user_id uuid,
  step_order integer,
  agent_id text,
  tool_name text,
  reversibility text,
  inputs jsonb,
  outputs jsonb,
  finished_at timestamptz,
  confirmation_card_id text
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select s.id
    from public.mission_steps s
    join public.missions m on m.id = s.mission_id
    where
      m.state = 'rolling_back'
      and s.status in ('succeeded', 'rollback_failed')
      and not exists (
        select 1
        from public.mission_execution_events e
        where
          e.step_id = s.id
          and e.event_type in (
            'rollback_step_succeeded',
            'rollback_step_failed',
            'rollback_step_skipped'
          )
      )
      and not exists (
        select 1
        from public.mission_steps later
        where
          later.mission_id = s.mission_id
          and later.step_order > s.step_order
          and later.status in ('succeeded', 'rollback_failed')
          and not exists (
            select 1
            from public.mission_execution_events le
            where
              le.step_id = later.id
              and le.event_type in (
                'rollback_step_succeeded',
                'rollback_step_failed',
                'rollback_step_skipped'
              )
          )
      )
    order by m.updated_at asc, s.step_order desc
    for update of s skip locked
    limit greatest(1, least(coalesce(requested_limit, 10), 50))
  ),
  claimed as (
    insert into public.mission_step_rollback_attempts (
      mission_id,
      step_id,
      attempt,
      status
    )
    select
      s.mission_id,
      s.id,
      1,
      'running'
    from candidates c
    join public.mission_steps s on s.id = c.id
    on conflict (step_id, attempt) do nothing
    returning step_id
  )
  select
    s.id,
    s.mission_id,
    m.user_id,
    s.step_order,
    s.agent_id,
    s.tool_name,
    s.reversibility,
    s.inputs,
    s.outputs,
    s.finished_at,
    s.confirmation_card_id
  from claimed c
  join public.mission_steps s on s.id = c.step_id
  join public.missions m on m.id = s.mission_id
  order by m.updated_at asc, s.step_order desc;
$$;

revoke execute on function public.next_rollback_step_for_execution(integer) from public, anon, authenticated;
grant execute on function public.next_rollback_step_for_execution(integer) to service_role;
