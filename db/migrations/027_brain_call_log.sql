-- Migration 027 — SDK-1 Brain SDK call telemetry log.
--
-- Codex fills the body for SDK-1. This file is the scaffold: table name,
-- expected columns from the SDK-1 brief in docs/specs/phase-3-master.md §1,
-- indexes, RLS, service-role grants, and the rollback comment block. The
-- typed Brain SDK writes one row here per Cloud Run brain call so we can
-- observe latency, retries, fallbacks, and circuit-breaker state across
-- every call site (lib/marketplace-intelligence.ts, lib/recall-core.ts,
-- lib/anomaly-detection-core.ts, lib/forecasting-core.ts, lib/orchestrator.ts,
-- and the new Phase-3 brain tools).
--
-- Related:
--   - docs/specs/phase-3-master.md §1 (SDK-1 deliverable)
--   - lib/brain-sdk/* (Codex SDK-1 implementation)
--   - tests/phase3-brain-sdk.test.mjs (verifies retries / circuit / telemetry)
--
-- Rollback:
--   drop index if exists public.brain_call_log_by_user_recent;
--   drop index if exists public.brain_call_log_by_endpoint_recent;
--   drop index if exists public.brain_call_log_by_outcome_recent;
--   drop index if exists public.brain_call_log_failures_recent;
--   drop index if exists public.brain_call_log_by_circuit_state;
--   drop table if exists public.brain_call_log;

create table if not exists public.brain_call_log (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references public.profiles(id) on delete cascade,
  user_hash           text,
  request_id          text not null,
  endpoint            text not null,
  sdk_version         text,
  outcome             text not null check (outcome in (
                        'ok',
                        'fallback',
                        'timeout',
                        'malformed',
                        'circuit_open',
                        'error'
                      )),
  attempt             integer not null default 1 check (attempt >= 0),
  max_attempts        integer check (max_attempts is null or max_attempts >= 1),
  retry_reason        text,
  fallback_reason     text,
  circuit_state       text check (circuit_state in ('closed', 'open', 'half_open')),
  latency_ms          integer check (latency_ms is null or latency_ms >= 0),
  budget_ms           integer check (budget_ms is null or budget_ms >= 0),
  http_status         integer,
  error_class         text,
  error_text          text,
  caller_agent_id     text,
  caller_surface      text,
  payload_redacted    jsonb not null default '{}'::jsonb,
  response_redacted   jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- Indexes (Codex may add more once usage patterns observed; reserved space
-- in 034_phase3_indexes_polish.sql for late-W4 tuning).
create index if not exists brain_call_log_by_user_recent
  on public.brain_call_log (user_id, created_at desc)
  where user_id is not null;

create index if not exists brain_call_log_by_endpoint_recent
  on public.brain_call_log (endpoint, created_at desc);

create index if not exists brain_call_log_by_outcome_recent
  on public.brain_call_log (outcome, created_at desc);

create index if not exists brain_call_log_failures_recent
  on public.brain_call_log (endpoint, created_at desc)
  where outcome in ('fallback', 'timeout', 'malformed', 'circuit_open', 'error');

create index if not exists brain_call_log_by_circuit_state
  on public.brain_call_log (endpoint, circuit_state, created_at desc)
  where circuit_state is not null;

alter table public.brain_call_log enable row level security;
revoke all on public.brain_call_log from anon, authenticated;
grant all on public.brain_call_log to service_role;
