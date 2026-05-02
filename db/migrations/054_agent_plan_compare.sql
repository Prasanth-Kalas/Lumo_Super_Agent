-- Migration 054 — PLAN-CLIENT-TS-PARALLEL-WRITE-1 comparison telemetry.
--
-- Captures one append-only row per chat turn comparing the authoritative
-- TypeScript planning result against the shadow Python /api/tools/plan
-- response. Python is observational only in this sprint; user-visible routing
-- continues to use the TypeScript result until agreement and latency prove out.
--
-- Rollback:
--   drop trigger if exists agent_plan_compare_append_only_guard on public.agent_plan_compare;
--   drop function if exists public.agent_plan_compare_append_only();
--   drop index if exists public.agent_plan_compare_by_session_turn;
--   drop index if exists public.agent_plan_compare_by_created;
--   drop table if exists public.agent_plan_compare;

create table if not exists public.agent_plan_compare (
  id                 bigint generated always as identity primary key,
  session_id         text not null
                       check (
                         length(session_id) between 1 and 200
                         and session_id !~ '[[:space:]]'
                       ),
  turn_id            text not null
                       check (
                         length(turn_id) between 1 and 240
                         and turn_id !~ '[[:space:]]'
                       ),
  user_id            uuid references public.profiles(id) on delete set null,
  ts_intent_bucket   text check (
                         ts_intent_bucket is null
                         or ts_intent_bucket in ('fast_path', 'tool_path', 'reasoning_path')
                       ),
  py_intent_bucket   text check (
                         py_intent_bucket is null
                         or py_intent_bucket in ('fast_path', 'tool_path', 'reasoning_path')
                       ),
  ts_planning_step   text check (
                         ts_planning_step is null
                         or ts_planning_step in ('clarification', 'selection', 'confirmation', 'post_booking')
                       ),
  py_planning_step   text check (
                         py_planning_step is null
                         or py_planning_step in ('clarification', 'selection', 'confirmation', 'post_booking')
                       ),
  agreement_bucket   boolean,
  agreement_step     boolean,
  ts_latency_ms      integer check (ts_latency_ms is null or ts_latency_ms >= 0),
  py_latency_ms      integer check (py_latency_ms is null or py_latency_ms >= 0),
  py_was_stub        boolean,
  py_error           text check (py_error is null or char_length(py_error) <= 240),
  created_at         timestamptz not null default now()
);

comment on table public.agent_plan_compare is
  'Append-only shadow telemetry comparing TypeScript planning to Python /api/tools/plan. TypeScript remains authoritative until a future cutover lane.';
comment on column public.agent_plan_compare.session_id is
  'Chat session identifier. No raw user prompt text is stored in this table.';
comment on column public.agent_plan_compare.turn_id is
  'Stable per-turn request identifier shared with the orchestrator timing span where possible.';
comment on column public.agent_plan_compare.py_was_stub is
  'True when the Python service responded with X-Lumo-Plan-Stub: 1. Expected near 100% until the Phase 1 classifier migration.';
comment on column public.agent_plan_compare.py_error is
  'Bounded structured error code for Python timeout/auth/http/validation failures. Do not store provider responses or prompt bodies.';

create index if not exists agent_plan_compare_by_created
  on public.agent_plan_compare (created_at desc);

create index if not exists agent_plan_compare_by_session_turn
  on public.agent_plan_compare (session_id, turn_id, created_at desc);

create or replace function public.agent_plan_compare_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    raise exception 'AGENT_PLAN_COMPARE_APPEND_ONLY'
      using hint = 'Insert a new comparison row instead of mutating planner telemetry.';
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_agent_plan_compare_delete', true) <> 'true' then
      raise exception 'AGENT_PLAN_COMPARE_DELETE_FORBIDDEN'
        using hint = 'Planner comparison rows are rollout evidence; only retention/privacy jobs may delete them.';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists agent_plan_compare_append_only_guard on public.agent_plan_compare;
create trigger agent_plan_compare_append_only_guard
  before update or delete on public.agent_plan_compare
  for each row execute function public.agent_plan_compare_append_only();

alter table public.agent_plan_compare enable row level security;

revoke all on public.agent_plan_compare from anon, authenticated;
grant select, insert, delete on public.agent_plan_compare to service_role;

-- Admin reads are intentionally mediated through service-role API routes after
-- application-level admin checks. Browser clients get no direct PostgREST
-- policy for this table.
