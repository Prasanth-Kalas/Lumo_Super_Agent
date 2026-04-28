-- Migration 037 — PERM-1 permissions, consent, audit, and kill-switch substrate.
--
-- Implements the schema required by docs/specs/sprint-4-perm-1-permissions-and-consent.md
-- and ADR-014:
--   - explicit per-user agent installs
--   - per-scope grants with consent text hashes and optional constraints
--   - append-only agent action audit log
--   - marketplace kill flag compatibility plus a three-tier kill-switch table
--
-- Rollback:
--   drop trigger if exists agent_action_audit_no_update on public.agent_action_audit;
--   drop trigger if exists agent_action_audit_no_delete on public.agent_action_audit;
--   drop function if exists public.agent_action_audit_append_only();
--   drop trigger if exists agent_kill_switches_touch_updated_at on public.agent_kill_switches;
--   drop trigger if exists marketplace_agents_touch_updated_at on public.marketplace_agents;
--   drop trigger if exists agent_installs_touch_updated_at on public.agent_installs;
--   drop index if exists public.agent_kill_switches_active_by_agent;
--   drop index if exists public.agent_kill_switches_active_global;
--   drop index if exists public.agent_action_audit_by_mission;
--   drop index if exists public.agent_action_audit_by_scope;
--   drop index if exists public.agent_action_audit_by_user_agent;
--   drop index if exists public.agent_scope_grants_active;
--   drop index if exists public.agent_installs_by_state;
--   drop table if exists public.agent_kill_switches;
--   drop table if exists public.agent_action_audit;
--   drop table if exists public.agent_scope_grants;
--   drop table if exists public.agent_installs;
--   alter table public.marketplace_agents drop column if exists killed;
--   alter table public.marketplace_agents drop column if exists kill_reason;
--   alter table public.marketplace_agents drop column if exists killed_at;
--   alter table public.marketplace_agents drop column if exists killed_by;

create extension if not exists pgcrypto;

-- Install state per (user, agent). This table is intentionally distinct from
-- the legacy user_agent_installs table introduced in migration 011; PERM-1 is
-- the v1 SDK permission substrate and carries versioning/consent semantics.
create table if not exists public.agent_installs (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  agent_id          text not null,
  agent_version     text not null,
  state             text not null default 'installed' check (state in (
                      'installed',
                      'suspended',
                      'revoked'
                    )),
  pinned_version    text,
  consent_text_hash text not null,
  installed_at      timestamptz not null default now(),
  revoked_at        timestamptz,
  cleanup_after     timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (user_id, agent_id)
);

create index if not exists agent_installs_by_state
  on public.agent_installs (state, updated_at desc)
  where state <> 'revoked';

drop trigger if exists agent_installs_touch_updated_at on public.agent_installs;
create trigger agent_installs_touch_updated_at
  before update on public.agent_installs
  for each row execute function public.touch_updated_at();

alter table public.agent_installs enable row level security;
revoke all on public.agent_installs from anon, authenticated;
grant all on public.agent_installs to service_role;

drop policy if exists agent_installs_select_own on public.agent_installs;
create policy agent_installs_select_own on public.agent_installs
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Per-scope grant. constraints stores normalised caps/qualifiers, for example:
-- {"up_to_per_invocation_usd":50,"per_day_usd":200,"specific_to":"user@example.com"}.
create table if not exists public.agent_scope_grants (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  agent_id          text not null,
  scope             text not null,
  granted           boolean not null default true,
  constraints       jsonb not null default '{}'::jsonb,
  expires_at        timestamptz,
  granted_at        timestamptz not null default now(),
  revoked_at        timestamptz,
  consent_text_hash text not null,
  primary key (user_id, agent_id, scope),
  foreign key (user_id, agent_id)
    references public.agent_installs(user_id, agent_id)
    on delete cascade
);

create index if not exists agent_scope_grants_active
  on public.agent_scope_grants (user_id, agent_id, scope)
  where granted = true;

alter table public.agent_scope_grants enable row level security;
revoke all on public.agent_scope_grants from anon, authenticated;
grant all on public.agent_scope_grants to service_role;

drop policy if exists agent_scope_grants_select_own on public.agent_scope_grants;
create policy agent_scope_grants_select_own on public.agent_scope_grants
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Audit substrate (append-only, ADR-014 §7).
create table if not exists public.agent_action_audit (
  id              bigint generated by default as identity primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  agent_id        text not null,
  agent_version   text not null,
  capability_id   text,
  scope_used      text not null,
  action          text not null,
  target_resource text,
  mission_id      uuid references public.missions(id) on delete cascade,
  mission_step_id uuid references public.mission_steps(id) on delete set null,
  request_id      uuid not null,
  evidence_hash   text not null,
  evidence        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists agent_action_audit_by_user_agent
  on public.agent_action_audit (user_id, agent_id, created_at desc);

create index if not exists agent_action_audit_by_scope
  on public.agent_action_audit (scope_used, created_at desc);

create index if not exists agent_action_audit_by_mission
  on public.agent_action_audit (mission_id)
  where mission_id is not null;

create or replace function public.agent_action_audit_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    raise exception 'AGENT_AUDIT_APPEND_ONLY'
      using hint = 'agent_action_audit is append-only; append a new audit event instead';
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_agent_audit_delete', true) <> 'true' then
      raise exception 'AGENT_AUDIT_APPEND_ONLY'
        using hint = 'agent_action_audit is append-only; only account-deletion cascade may remove rows';
    end if;
  end if;

  return null;
end;
$$;

drop trigger if exists agent_action_audit_no_update on public.agent_action_audit;
create trigger agent_action_audit_no_update
  before update on public.agent_action_audit
  for each row execute function public.agent_action_audit_append_only();

drop trigger if exists agent_action_audit_no_delete on public.agent_action_audit;
create trigger agent_action_audit_no_delete
  before delete on public.agent_action_audit
  for each row execute function public.agent_action_audit_append_only();

alter table public.agent_action_audit enable row level security;
revoke all on public.agent_action_audit from anon, authenticated;
grant all on public.agent_action_audit to service_role;
grant usage, select on sequence public.agent_action_audit_id_seq to service_role;

drop policy if exists agent_action_audit_select_own on public.agent_action_audit;
create policy agent_action_audit_select_own on public.agent_action_audit
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Marketplace stub if MARKETPLACE-1 has not landed yet. MARKETPLACE-1 may add
-- additional catalogue columns, but PERM-1 needs the kill flag immediately.
create table if not exists public.marketplace_agents (
  agent_id   text primary key,
  manifest   jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.marketplace_agents
  add column if not exists killed boolean not null default false,
  add column if not exists kill_reason text,
  add column if not exists killed_at timestamptz,
  add column if not exists killed_by uuid references public.profiles(id) on delete set null;

drop trigger if exists marketplace_agents_touch_updated_at on public.marketplace_agents;
create trigger marketplace_agents_touch_updated_at
  before update on public.marketplace_agents
  for each row execute function public.touch_updated_at();

alter table public.marketplace_agents enable row level security;
revoke all on public.marketplace_agents from anon, authenticated;
grant all on public.marketplace_agents to service_role;
grant select on public.marketplace_agents to anon, authenticated;

drop policy if exists marketplace_agents_public_select on public.marketplace_agents;
create policy marketplace_agents_public_select on public.marketplace_agents
  for select
  to anon, authenticated
  using (true);

-- Three-tier kill-switch substrate:
--   system:         all agents for every user
--   agent:          one agent for every user
--   user:           all agents for one user
--   user_agent:     one agent for one user
create table if not exists public.agent_kill_switches (
  id          uuid primary key default gen_random_uuid(),
  switch_type text not null check (switch_type in (
                'system',
                'agent',
                'user',
                'user_agent'
              )),
  agent_id    text,
  user_id     uuid references public.profiles(id) on delete cascade,
  active      boolean not null default true,
  reason      text not null,
  severity    text not null default 'medium' check (severity in (
                'critical',
                'high',
                'medium',
                'low'
              )),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  disabled_at timestamptz,
  check (
    (switch_type = 'system' and agent_id is null and user_id is null)
    or (switch_type = 'agent' and agent_id is not null and user_id is null)
    or (switch_type = 'user' and agent_id is null and user_id is not null)
    or (switch_type = 'user_agent' and agent_id is not null and user_id is not null)
  )
);

create index if not exists agent_kill_switches_active_global
  on public.agent_kill_switches (switch_type, created_at desc)
  where active = true;

create index if not exists agent_kill_switches_active_by_agent
  on public.agent_kill_switches (agent_id, switch_type, created_at desc)
  where active = true and agent_id is not null;

create index if not exists agent_kill_switches_active_by_user
  on public.agent_kill_switches (user_id, switch_type, created_at desc)
  where active = true and user_id is not null;

drop trigger if exists agent_kill_switches_touch_updated_at on public.agent_kill_switches;
create trigger agent_kill_switches_touch_updated_at
  before update on public.agent_kill_switches
  for each row execute function public.touch_updated_at();

alter table public.agent_kill_switches enable row level security;
revoke all on public.agent_kill_switches from anon, authenticated;
grant all on public.agent_kill_switches to service_role;
