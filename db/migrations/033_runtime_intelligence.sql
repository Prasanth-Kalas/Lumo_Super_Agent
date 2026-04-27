-- Migration 033 — RUNTIME-1 agent runtime intelligence substrate.
--
-- Codex fills the body for RUNTIME-1. This file is the scaffold: three
-- tables for the W4 platform-watching-itself layer:
--
--   - agent_outputs_sampled — sampled agent outputs (with quality signals)
--     used to build a 7-day rolling reference distribution for KS / JS
--     drift detection per ADR-aligned spec in phase-3-master.md §7.
--   - model_routing_log — every provider-routing decision with latency,
--     cost, classifier label so the orchestrator can backtest its forecast.
--   - prompt_ab_arms — prompt-version A/B counters used by the runtime
--     intelligence admin surface.
--
-- The two RUNTIME-1 deliverables not in this scaffold (drift checker and
-- connector hazard) are pure brain-side logic; they read from these tables
-- and from agent_tool_usage. Connector_health writes happen via the existing
-- ops_observability schema.
--
-- Related:
--   - docs/specs/phase-3-master.md §7 (RUNTIME-1 deliverable)
--   - tests/phase3-runtime-intelligence.test.mjs (drift KS, A/B aggregation,
--     model routing classifier coverage)
--   - app/admin/intelligence/* (Coworker D — DO NOT TOUCH)
--
-- Open schema decisions escalated to Kalas:
--   - Sampling rate for agent_outputs_sampled (ADR ref says 7-day rolling
--     window; sample rate is undeclared). Scaffold leaves it to runtime
--     config; Codex sets a default of 5% per agent.
--   - Whether prompt_ab_arms needs separate counters per surface or per
--     agent. Scaffold goes per (agent_id, prompt_version) — confirm.
--
-- Rollback:
--   drop index if exists public.prompt_ab_arms_by_agent_version;
--   drop index if exists public.model_routing_log_by_label;
--   drop index if exists public.model_routing_log_by_query;
--   drop index if exists public.model_routing_log_recent;
--   drop index if exists public.agent_outputs_sampled_by_agent_recent;
--   drop index if exists public.agent_outputs_sampled_by_input_hash;
--   drop table if exists public.prompt_ab_arms;
--   drop table if exists public.model_routing_log;
--   drop table if exists public.agent_outputs_sampled;

create table if not exists public.agent_outputs_sampled (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references public.profiles(id) on delete cascade,
  agent_id            text not null,
  prompt_version      text,
  input_hash          text not null,                       -- SHA-256 of normalised input
  output_text         text,                                -- redacted output text
  output_tokens       integer check (output_tokens is null or output_tokens >= 0),
  classifier_label    text,
  quality_signals     jsonb not null default '{}'::jsonb,  -- {accepted: bool, refused: bool, latency_ms: int, etc.}
  sampled_at          timestamptz not null default now()
);

create index if not exists agent_outputs_sampled_by_agent_recent
  on public.agent_outputs_sampled (agent_id, sampled_at desc);

create index if not exists agent_outputs_sampled_by_input_hash
  on public.agent_outputs_sampled (agent_id, input_hash);

alter table public.agent_outputs_sampled enable row level security;
revoke all on public.agent_outputs_sampled from anon, authenticated;
grant all on public.agent_outputs_sampled to service_role;

create table if not exists public.model_routing_log (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references public.profiles(id) on delete cascade,
  query_id            text not null,
  classifier_label    text,
  routed_model        text not null,                       -- e.g. 'claude-3-5-sonnet', 'gpt-4o', 'gemini-1.5-pro'
  routed_provider     text,
  forecast_cost_usd   numeric(8, 6),
  forecast_latency_ms integer,
  forecast_confidence real check (forecast_confidence is null or (forecast_confidence between 0 and 1)),
  fell_back_to_table  boolean not null default false,      -- true when forecast confidence < 0.6
  latency_ms          integer check (latency_ms is null or latency_ms >= 0),
  cost_usd            numeric(8, 6),
  status              text not null default 'success' check (status in (
                        'success',
                        'fallback',
                        'timeout',
                        'error'
                      )),
  created_at          timestamptz not null default now()
);

create index if not exists model_routing_log_recent
  on public.model_routing_log (created_at desc);

create index if not exists model_routing_log_by_query
  on public.model_routing_log (query_id);

create index if not exists model_routing_log_by_label
  on public.model_routing_log (classifier_label, created_at desc);

alter table public.model_routing_log enable row level security;
revoke all on public.model_routing_log from anon, authenticated;
grant all on public.model_routing_log to service_role;

create table if not exists public.prompt_ab_arms (
  id                  uuid primary key default gen_random_uuid(),
  agent_id            text not null,
  prompt_version      text not null,
  samples_count       bigint not null default 0,
  accept_count        bigint not null default 0,
  refusal_count       bigint not null default 0,
  latency_p50_ms      integer,
  latency_p95_ms      integer,
  cost_usd_total      numeric(12, 6) not null default 0,
  last_sampled_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (agent_id, prompt_version)
);

create index if not exists prompt_ab_arms_by_agent_version
  on public.prompt_ab_arms (agent_id, prompt_version);

drop trigger if exists prompt_ab_arms_touch_updated_at on public.prompt_ab_arms;
create trigger prompt_ab_arms_touch_updated_at
  before update on public.prompt_ab_arms
  for each row execute function public.touch_updated_at();

alter table public.prompt_ab_arms enable row level security;
revoke all on public.prompt_ab_arms from anon, authenticated;
grant all on public.prompt_ab_arms to service_role;
