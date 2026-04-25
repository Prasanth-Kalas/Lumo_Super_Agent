-- Migration 011 — app-store runtime governance.
--
-- Certification and admin approval decide whether an agent can enter the
-- marketplace. These tables decide whether a specific user may run a
-- specific agent at runtime.
--
-- user_agent_installs:
--   Explicit app install state for connectionless agents and a durable
--   permission snapshot for OAuth agents. OAuth connect writes/updates this
--   row automatically; public agents get installed through /api/apps/install.
--
-- agent_runtime_overrides:
--   Admin kill-switch and quota knobs. A suspended/revoked agent remains in
--   history but is blocked before dispatch.
--
-- agent_tool_usage:
--   Narrow dispatch ledger used for quota checks and publisher reporting. It
--   stores tool names and outcomes, not tool arguments or user PII.

create table if not exists public.user_agent_installs (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  agent_id      text not null,
  status        text not null default 'installed' check (status in (
                  'installed', 'suspended', 'revoked'
                )),
  permissions   jsonb not null default '{}'::jsonb,
  install_source text not null default 'marketplace' check (install_source in (
                  'marketplace', 'oauth', 'admin', 'migration'
                )),
  installed_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (user_id, agent_id)
);

drop trigger if exists user_agent_installs_touch_updated_at on public.user_agent_installs;
create trigger user_agent_installs_touch_updated_at
  before update on public.user_agent_installs
  for each row execute function public.tg_touch_updated_at();

create index if not exists user_agent_installs_active_by_user
  on public.user_agent_installs (user_id, updated_at desc)
  where status = 'installed';

create table if not exists public.agent_runtime_overrides (
  agent_id                       text primary key,
  status                         text not null default 'active' check (status in (
                                   'active', 'suspended', 'revoked'
                                 )),
  reason                         text,
  max_calls_per_user_per_minute  integer not null default 30 check (max_calls_per_user_per_minute > 0),
  max_calls_per_user_per_day     integer not null default 1000 check (max_calls_per_user_per_day > 0),
  max_money_calls_per_user_per_day integer not null default 25 check (max_money_calls_per_user_per_day > 0),
  updated_by                     text,
  updated_at                     timestamptz not null default now()
);

drop trigger if exists agent_runtime_overrides_touch_updated_at on public.agent_runtime_overrides;
create trigger agent_runtime_overrides_touch_updated_at
  before update on public.agent_runtime_overrides
  for each row execute function public.tg_touch_updated_at();

create table if not exists public.agent_tool_usage (
  id          text primary key,
  user_id     uuid references public.profiles(id) on delete set null,
  agent_id    text not null,
  tool_name   text not null,
  cost_tier   text not null,
  ok          boolean not null,
  error_code  text,
  latency_ms  integer not null check (latency_ms >= 0),
  created_at  timestamptz not null default now(),
  created_on_utc date not null default (now() at time zone 'UTC')::date
);

create index if not exists agent_tool_usage_user_agent_minute
  on public.agent_tool_usage (user_id, agent_id, created_at desc)
  where user_id is not null;

create index if not exists agent_tool_usage_user_agent_day
  on public.agent_tool_usage (user_id, agent_id, created_on_utc)
  where user_id is not null;

create index if not exists agent_tool_usage_agent_recent
  on public.agent_tool_usage (agent_id, created_at desc);
