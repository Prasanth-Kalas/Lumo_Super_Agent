-- Migration 045 — MESH-1 sub-agent call ledger.
--
-- Implements docs/specs/lumo-jarvis-master-roadmap.md §7:
--   - supervisor/sub-agent fan-out observability
--   - per-sub-agent latency, model, and status evidence
--   - nested sub-agent parentage for future mesh recursion
--
-- Rollback:
--   drop trigger if exists subagent_calls_append_only_guard on public.subagent_calls;
--   drop function if exists public.subagent_calls_append_only();
--   drop index if exists public.subagent_calls_by_parent;
--   drop index if exists public.subagent_calls_by_subagent_started;
--   drop index if exists public.subagent_calls_by_request;
--   drop table if exists public.subagent_calls;

create table if not exists public.subagent_calls (
  id             uuid primary key default gen_random_uuid(),
  request_id     text not null
                   check (
                     length(request_id) between 1 and 200
                     and request_id !~ '[[:space:]]'
                   ),
  parent_call_id uuid references public.subagent_calls(id) on delete set null,
  subagent_name  text not null
                   check (
                     length(subagent_name) between 1 and 96
                     and subagent_name ~ '^[a-z][a-z0-9_.-]*$'
                   ),
  model_used     text not null
                   check (
                     length(model_used) between 1 and 120
                     and model_used !~ '[[:space:]]'
                   ),
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  duration_ms    integer generated always as (
                   greatest(
                     0,
                     floor(extract(epoch from (ended_at - started_at)) * 1000)::integer
                   )
                 ) stored,
  input_hash     text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  output_summary text check (output_summary is null or char_length(output_summary) <= 2000),
  status         text not null
                   check (status in ('completed','failed','timeout','fallback','cancelled')),
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  check (ended_at >= started_at),
  check (jsonb_typeof(metadata) = 'object')
);

comment on table public.subagent_calls is
  'MESH-1 append-only ledger for supervisor fan-out. One row per completed sub-agent invocation.';
comment on column public.subagent_calls.request_id is
  'Stable per-turn request identifier shared with agent_request_timings, used to group supervisor and sub-agent evidence.';
comment on column public.subagent_calls.parent_call_id is
  'Optional parent sub-agent call for nested fan-out. Null for first-level supervisor children.';
comment on column public.subagent_calls.input_hash is
  'SHA-256 of canonical bounded sub-agent input. Raw prompts, user messages, PII, and provider secrets must not be stored here.';
comment on column public.subagent_calls.output_summary is
  'Short operational summary only. Full sub-agent outputs remain in process memory and the orchestrator context, not the ledger.';
comment on column public.subagent_calls.metadata is
  'Bounded observability metadata such as provider, timeout_ms, fallback_used, tool_count, or error_code. Do not store raw prompt/user text.';

create index if not exists subagent_calls_by_request
  on public.subagent_calls (request_id, started_at asc, id asc);

create index if not exists subagent_calls_by_subagent_started
  on public.subagent_calls (subagent_name, started_at desc);

create index if not exists subagent_calls_by_parent
  on public.subagent_calls (parent_call_id, started_at asc)
  where parent_call_id is not null;

create or replace function public.subagent_calls_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    raise exception 'SUBAGENT_CALLS_APPEND_ONLY'
      using hint = 'Insert a new sub-agent call row instead of mutating mesh execution evidence.';
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_subagent_call_delete', true) <> 'true' then
      raise exception 'SUBAGENT_CALLS_DELETE_FORBIDDEN'
        using hint = 'Sub-agent calls are execution evidence; only retention/privacy jobs may delete them.';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists subagent_calls_append_only_guard on public.subagent_calls;
create trigger subagent_calls_append_only_guard
  before update or delete on public.subagent_calls
  for each row execute function public.subagent_calls_append_only();

alter table public.subagent_calls enable row level security;

revoke all on public.subagent_calls from anon, authenticated;
grant select, insert, delete on public.subagent_calls to service_role;

-- Admin reads are intentionally mediated through service-role API routes after
-- application-level admin checks. Browser clients get no direct PostgREST
-- policy for this table.
