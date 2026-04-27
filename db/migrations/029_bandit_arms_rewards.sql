-- Migration 029 — BANDIT-1 contextual bandit substrate.
--
-- Codex fills the body for BANDIT-1. This file is the scaffold: bandit_arms
-- (per-user LinUCB state — theta, A_inv, b), bandit_rewards (per-event
-- context+reward log used by both online increments and the nightly Modal
-- retraining job), bandit_cohort_priors (warm-start per surface/cohort), and
-- bandit_user_models (per-user weights index, ADR-009 §4 §10). Codex adds the
-- two brain tool RPCs (lumo_personalize_rank, lumo_log_outcome) and the
-- promotion-flag column read by the LinUCB->Thompson promotion path.
--
-- Related:
--   - docs/specs/adr-009-bandit-algorithm.md (sealed)
--   - docs/specs/phase-3-master.md §3 (BANDIT-1 deliverable)
--   - tests/phase3-bandit-arms.test.mjs
--   - tests/phase3-bandit-promotion.test.mjs
--
-- Open schema decisions escalated to Kalas:
--   - Vector dim for context_vector. ADR-009 §6 puts the context vector at
--     ~18-23 dims; scaffold uses vector(32) to leave headroom. Confirm.
--   - Whether A_inv and theta should be jsonb (portable, debuggable) or
--     bytea (compact). Scaffold uses jsonb per ADR-009 §4. Codex may switch
--     to bytea if jsonb proves too slow at 1k MAU.
--
-- Rollback:
--   drop function if exists public.lumo_log_outcome(uuid, text, text, integer, jsonb);
--   drop function if exists public.lumo_personalize_rank(uuid, text, jsonb, jsonb);
--   drop index    if exists public.bandit_rewards_by_user_arm;
--   drop index    if exists public.bandit_rewards_by_user_surface_recent;
--   drop index    if exists public.bandit_rewards_by_created;
--   drop index    if exists public.bandit_arms_by_user_surface;
--   drop index    if exists public.bandit_arms_promoted;
--   drop index    if exists public.bandit_user_models_by_user_surface;
--   drop index    if exists public.bandit_cohort_priors_by_surface_cohort;
--   drop table    if exists public.bandit_rewards;
--   drop table    if exists public.bandit_arms;
--   drop table    if exists public.bandit_user_models;
--   drop table    if exists public.bandit_cohort_priors;

create extension if not exists vector;

-- Cohort priors: 3 cohorts per surface, recomputed weekly (ADR-009 §4).
create table if not exists public.bandit_cohort_priors (
  id            uuid primary key default gen_random_uuid(),
  surface       text not null check (surface in (
                  'marketplace_tile',
                  'proactive_moment',
                  'chat_suggestion'
                )),
  cohort_id     text not null,                       -- 'low'|'medium'|'high'
  weights_jsonb jsonb not null default '{}'::jsonb,  -- theta, A_inv, b
  computed_at   timestamptz not null default now(),
  unique (surface, cohort_id)
);

create index if not exists bandit_cohort_priors_by_surface_cohort
  on public.bandit_cohort_priors (surface, cohort_id, computed_at desc);

-- Per-user model index (ADR-009 §4): which model_version is active per user
-- per surface. Promotion to Thompson flips a flag here.
create table if not exists public.bandit_user_models (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  surface                  text not null check (surface in (
                             'marketplace_tile',
                             'proactive_moment',
                             'chat_suggestion'
                           )),
  algorithm                text not null default 'linucb' check (algorithm in (
                             'linucb',
                             'thompson'
                           )),
  model_version            text not null,
  alpha                    real not null default 1.0,            -- LinUCB confidence radius
  cold_start_event_count   integer not null default 0,
  promoted_at              timestamptz,
  weights_jsonb            jsonb not null default '{}'::jsonb,
  updated_at               timestamptz not null default now(),
  unique (user_id, surface)
);

create index if not exists bandit_user_models_by_user_surface
  on public.bandit_user_models (user_id, surface, updated_at desc);

-- Per-arm LinUCB state (theta, A_inv, b are the LinUCB primitives).
create table if not exists public.bandit_arms (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  surface         text not null,
  arm_id          text not null,                       -- candidate id
  theta           jsonb not null default '[]'::jsonb,  -- d-dim weights
  a_inv           jsonb not null default '[]'::jsonb,  -- d x d covariance inverse
  b              jsonb not null default '[]'::jsonb,   -- d-dim accumulator
  update_count    integer not null default 0,
  last_reward_at  timestamptz,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (user_id, surface, arm_id)
);

create index if not exists bandit_arms_by_user_surface
  on public.bandit_arms (user_id, surface, updated_at desc);

create index if not exists bandit_arms_promoted
  on public.bandit_arms (user_id, surface)
  where update_count >= 100;

-- Per-event rewards log. Online increments and nightly retraining both read
-- this table; never deleted in v1 (retention policy is a Phase-4 question).
create table if not exists public.bandit_rewards (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  surface         text not null,
  arm_id          text not null,
  context_vector  vector(32),
  reward          integer not null check (reward between -2 and 2),
  event_type      text not null check (event_type in (
                    'impression',
                    'click',
                    'dismiss',
                    'dwell',
                    'install',
                    'action_completed'
                  )),
  request_id      text,
  ab_assignment   text check (ab_assignment in ('control', 'treatment') or ab_assignment is null),
  created_at      timestamptz not null default now()
);

create index if not exists bandit_rewards_by_user_arm
  on public.bandit_rewards (user_id, surface, arm_id, created_at desc);

create index if not exists bandit_rewards_by_user_surface_recent
  on public.bandit_rewards (user_id, surface, created_at desc);

create index if not exists bandit_rewards_by_created
  on public.bandit_rewards (created_at);

alter table public.bandit_cohort_priors enable row level security;
revoke all on public.bandit_cohort_priors from anon, authenticated;
grant all on public.bandit_cohort_priors to service_role;

alter table public.bandit_user_models enable row level security;
revoke all on public.bandit_user_models from anon, authenticated;
grant all on public.bandit_user_models to service_role;

alter table public.bandit_arms enable row level security;
revoke all on public.bandit_arms from anon, authenticated;
grant all on public.bandit_arms to service_role;

alter table public.bandit_rewards enable row level security;
revoke all on public.bandit_rewards from anon, authenticated;
grant all on public.bandit_rewards to service_role;

-- Codex fills:
--   create or replace function public.lumo_personalize_rank(...)
--   create or replace function public.lumo_log_outcome(...)
-- Both security definer, search_path=public, service_role-only execute.
