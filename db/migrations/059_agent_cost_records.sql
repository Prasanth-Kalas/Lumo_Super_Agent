-- Migration 059 — PYTHON-OBSERVABILITY-1 cost telemetry table.
--
-- One row per cost-incurring operation (LLM token, embedding, GPU
-- second). Append-only, separate from agent_plan_compare because
-- cardinality and lifecycle differ:
--
--   agent_plan_compare:  1 row per turn  (transient, 30-day retention)
--   agent_cost_records:  N rows per turn (durable, 90-day retention)
--
-- The Python brain's lumo_ml.core.record_cost(...) attaches values
-- to the active OTel span as a structured event. Codex's plan-client
-- logger reads those events from Honeycomb's export pipeline (or
-- directly from response telemetry once wired) and writes rows here.
--
-- Schema deviations from the brief's spec, called out in design §11:
--
--   * dollars_estimated is numeric(12,6) instead of numeric(10,4) —
--     gives $999,999.999999 headroom so monthly aggregations don't
--     overflow at scale (per §11.7).
--
--   * span_id text — added so finer-grain trace correlation is
--     possible without re-deriving from request_id alone (per §11.9).
--
--   * metadata jsonb default '{}' — bounded escape hatch for things
--     we'll wish we had later (model name, batch size, error code)
--     without needing a new fixed column per dimension (per §11.10).
--
-- Rollback:
--   drop trigger if exists agent_cost_records_append_only_guard
--     on public.agent_cost_records;
--   drop function if exists public.agent_cost_records_append_only();
--   drop index if exists public.agent_cost_records_by_request;
--   drop index if exists public.agent_cost_records_by_user_time;
--   drop table if exists public.agent_cost_records;

create table if not exists public.agent_cost_records (
  id                 bigint generated always as identity primary key,
  request_id         uuid not null,
  span_id            text check (
                       span_id is null
                       or (length(span_id) between 1 and 32 and span_id ~ '^[a-f0-9]+$')
                     ),
  user_id            uuid references auth.users(id) on delete set null,
  operation          text not null
                       check (operation ~ '^[a-z][a-z0-9_.]{2,79}$'),
  tokens_in          integer not null default 0
                       check (tokens_in >= 0),
  tokens_out         integer not null default 0
                       check (tokens_out >= 0),
  embedding_ops      integer not null default 0
                       check (embedding_ops >= 0),
  gpu_seconds        real    not null default 0
                       check (gpu_seconds >= 0),
  dollars_estimated  numeric(12, 6) not null default 0
                       check (dollars_estimated >= 0),
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

comment on table public.agent_cost_records is
  'Append-only cost telemetry. One row per LLM token / embedding op / GPU second. 90-day retention; pruned by cron.';
comment on column public.agent_cost_records.request_id is
  'Trace ID (W3C traceparent) coerced to UUID. Joins this row to OTel spans in Honeycomb / Tempo / Datadog.';
comment on column public.agent_cost_records.span_id is
  '16-hex-char OTel span ID. Lets analysts pinpoint which sub-operation incurred the cost.';
comment on column public.agent_cost_records.operation is
  'Lowercase dotted name. e.g. ``classifier.classify``, ``embedding.bge_large``, ``llm.anthropic.claude-3-5-sonnet``.';
comment on column public.agent_cost_records.dollars_estimated is
  'Estimated dollar cost. numeric(12,6) for monthly-aggregation headroom — hits 999,999.999999 before overflow.';
comment on column public.agent_cost_records.metadata is
  'Bounded escape hatch for model name / batch size / error code etc. Don''t use for indexed query fields — add a column instead.';

create index agent_cost_records_by_user_time
  on public.agent_cost_records (user_id, created_at desc)
  where user_id is not null;
create index agent_cost_records_by_request
  on public.agent_cost_records (request_id);

-- Append-only invariant — mirrors agent_plan_compare's pattern.
create or replace function public.agent_cost_records_append_only()
  returns trigger
  language plpgsql
  as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if coalesce(current_setting('lumo.allow_agent_cost_records_delete', true), 'off')
       <> 'on'
    then
      raise exception 'agent_cost_records is append-only';
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists agent_cost_records_append_only_guard
  on public.agent_cost_records;
create trigger agent_cost_records_append_only_guard
  before update or delete on public.agent_cost_records
  for each row execute function public.agent_cost_records_append_only();

-- RLS — service-role only, mirrors agent_plan_compare.
alter table public.agent_cost_records enable row level security;

drop policy if exists agent_cost_records_service_role
  on public.agent_cost_records;
create policy agent_cost_records_service_role
  on public.agent_cost_records
  for all
  to service_role
  using (true)
  with check (true);
