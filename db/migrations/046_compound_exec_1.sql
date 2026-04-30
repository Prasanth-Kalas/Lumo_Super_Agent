-- Migration 046 — COMPOUND-EXEC-1 compound transaction execution substrate.
--
-- Implements docs/specs/lumo-jarvis-master-roadmap.md §4.5 and ADR-017 §7:
--   - one commercial unit spanning multiple merchant transaction rows
--   - explicit dependency DAG edges between existing transaction_legs
--   - append-only SSE v2 leg status events for deterministic replay
--
-- Rollback:
--   drop trigger if exists leg_status_events_append_only_guard on public.leg_status_events;
--   drop function if exists public.leg_status_events_append_only();
--   drop trigger if exists leg_status_events_validate_leg_guard on public.leg_status_events;
--   drop function if exists public.leg_status_events_validate_leg();
--   drop trigger if exists compound_transaction_dependencies_append_only_guard on public.compound_transaction_dependencies;
--   drop function if exists public.compound_transaction_dependencies_append_only();
--   drop trigger if exists compound_transaction_dependencies_validate_legs_guard on public.compound_transaction_dependencies;
--   drop function if exists public.compound_transaction_dependencies_validate_legs();
--   drop trigger if exists transactions_compound_link_once_guard on public.transactions;
--   drop function if exists public.transactions_compound_link_once();
--   drop trigger if exists compound_transactions_retry_safe_guard on public.compound_transactions;
--   drop function if exists public.compound_transactions_retry_safe_append_only();
--   drop trigger if exists compound_transactions_touch_updated_at on public.compound_transactions;
--   drop index if exists public.leg_status_events_by_status_time;
--   drop index if exists public.leg_status_events_by_leg_time;
--   drop index if exists public.leg_status_events_by_compound_replay;
--   drop index if exists public.compound_dependencies_by_dependency_leg;
--   drop index if exists public.compound_dependencies_by_dependent_leg;
--   drop index if exists public.transactions_by_compound;
--   drop index if exists public.compound_transactions_open;
--   drop index if exists public.compound_transactions_by_mission;
--   drop index if exists public.compound_transactions_by_user_created;
--   drop table if exists public.leg_status_events;
--   drop table if exists public.compound_transaction_dependencies;
--   alter table public.transactions drop constraint if exists transactions_compound_transaction_id_fkey;
--   alter table public.transactions drop column if exists compound_transaction_id;
--   drop table if exists public.compound_transactions;

create extension if not exists pgcrypto;

create table if not exists public.compound_transactions (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  mission_id                  uuid references public.missions(id) on delete set null,
  session_id                  text check (
                                session_id is null
                                or (length(session_id) between 1 and 200 and session_id !~ '[[:space:]]')
                              ),
  primary_transaction_id      uuid references public.transactions(id) on delete set null,
  idempotency_key             text not null check (
                                length(idempotency_key) between 1 and 240
                                and idempotency_key !~ '[[:space:]]'
                              ),
  graph_hash                  text not null check (graph_hash ~ '^[a-f0-9]{64}$'),
  confirmation_digest         text check (confirmation_digest is null or confirmation_digest ~ '^[a-f0-9]{64}$'),
  status                      text not null default 'draft' check (
                                status in (
                                  'draft',
                                  'awaiting_confirmation',
                                  'authorized',
                                  'executing',
                                  'partially_committed',
                                  'committed',
                                  'rolling_back',
                                  'rolled_back',
                                  'rollback_failed',
                                  'failed',
                                  'manual_review',
                                  'cancelled'
                                )
                              ),
  currency                    text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  authorized_amount_cents     integer not null default 0 check (authorized_amount_cents >= 0),
  captured_amount_cents       integer not null default 0 check (captured_amount_cents >= 0),
  refunded_amount_cents       integer not null default 0 check (refunded_amount_cents >= 0),
  failure_policy              text not null default 'rollback' check (
                                failure_policy in ('rollback','manual_review')
                              ),
  failure_reason              text check (
                                failure_reason is null or char_length(failure_reason) <= 2000
                              ),
  current_replay_hash         text check (
                                current_replay_hash is null or current_replay_hash ~ '^[a-f0-9]{64}$'
                              ),
  evidence                    jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (user_id, idempotency_key),
  check (captured_amount_cents <= authorized_amount_cents),
  check (refunded_amount_cents <= captured_amount_cents),
  check (jsonb_typeof(evidence) = 'object')
);

comment on table public.compound_transactions is
  'COMPOUND-EXEC-1 commercial unit for multi-leg merchant bookings. Existing transactions rows link here through transactions.compound_transaction_id.';
comment on column public.compound_transactions.graph_hash is
  'SHA-256 of the canonical dependency graph. Re-running the same graph over the same ledger snapshot must produce the same next saga action.';
comment on column public.compound_transactions.current_replay_hash is
  'Optional SHA-256 of the last deterministic replay action plan emitted by the saga runner.';
comment on column public.compound_transactions.evidence is
  'Bounded operational evidence only. Do not store raw provider payloads, card data, prompts, or secrets.';

create index if not exists compound_transactions_by_user_created
  on public.compound_transactions (user_id, created_at desc);

create index if not exists compound_transactions_by_mission
  on public.compound_transactions (mission_id, created_at desc)
  where mission_id is not null;

create index if not exists compound_transactions_open
  on public.compound_transactions (status, updated_at asc)
  where status not in ('committed','rolled_back','failed','cancelled');

drop trigger if exists compound_transactions_touch_updated_at on public.compound_transactions;
create trigger compound_transactions_touch_updated_at
  before update on public.compound_transactions
  for each row execute function public.touch_updated_at();

create or replace function public.compound_transactions_retry_safe_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    if old.id is distinct from new.id
       or old.user_id is distinct from new.user_id
       or old.mission_id is distinct from new.mission_id
       or old.session_id is distinct from new.session_id
       or old.idempotency_key is distinct from new.idempotency_key
       or old.graph_hash is distinct from new.graph_hash
       or old.confirmation_digest is distinct from new.confirmation_digest
       or old.created_at is distinct from new.created_at then
      raise exception 'COMPOUND_TRANSACTION_IDENTITY_IMMUTABLE'
        using hint = 'Saga reconciliation may update status, amounts, replay hash, and evidence, but graph identity is immutable';
    end if;
    return new;
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_compound_transaction_delete', true) <> 'true' then
      raise exception 'COMPOUND_TRANSACTIONS_APPEND_ONLY'
        using hint = 'Compound transactions are commercial ledger evidence; retention/privacy jobs must set the explicit delete GUC';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists compound_transactions_retry_safe_guard on public.compound_transactions;
create trigger compound_transactions_retry_safe_guard
  before update or delete on public.compound_transactions
  for each row execute function public.compound_transactions_retry_safe_append_only();

alter table public.transactions
  add column if not exists compound_transaction_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'transactions_compound_transaction_id_fkey'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint transactions_compound_transaction_id_fkey
      foreign key (compound_transaction_id)
      references public.compound_transactions(id)
      on delete set null;
  end if;
end;
$$;

comment on column public.transactions.compound_transaction_id is
  'Optional COMPOUND-EXEC-1 parent commercial unit. Null for single-leg MERCHANT-1 transactions.';

create index if not exists transactions_by_compound
  on public.transactions (compound_transaction_id, created_at asc)
  where compound_transaction_id is not null;

create or replace function public.transactions_compound_link_once()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.compound_transaction_id is not null
     and old.compound_transaction_id is distinct from new.compound_transaction_id then
    raise exception 'TRANSACTION_COMPOUND_LINK_IMMUTABLE'
      using hint = 'A transaction may be attached to a compound transaction once, but the link cannot be moved afterward';
  end if;

  return new;
end;
$$;

drop trigger if exists transactions_compound_link_once_guard on public.transactions;
create trigger transactions_compound_link_once_guard
  before update on public.transactions
  for each row execute function public.transactions_compound_link_once();

create table if not exists public.compound_transaction_dependencies (
  id                       uuid primary key default gen_random_uuid(),
  compound_transaction_id  uuid not null references public.compound_transactions(id) on delete cascade,
  dependency_leg_id        uuid not null references public.transaction_legs(id) on delete cascade,
  dependent_leg_id         uuid not null references public.transaction_legs(id) on delete cascade,
  edge_type                text not null check (
                             edge_type in (
                               'requires_arrival_time',
                               'requires_destination',
                               'requires_payment_authorization',
                               'requires_user_confirmation',
                               'requires_provider_reference',
                               'custom'
                             )
                           ),
  evidence                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  unique (compound_transaction_id, dependency_leg_id, dependent_leg_id, edge_type),
  check (dependency_leg_id <> dependent_leg_id),
  check (jsonb_typeof(evidence) = 'object')
);

comment on table public.compound_transaction_dependencies is
  'COMPOUND-EXEC-1 DAG edges. dependent_leg_id cannot execute until dependency_leg_id has committed or been explicitly skipped.';
comment on column public.compound_transaction_dependencies.edge_type is
  'Typed dependency rationale for deterministic planning and user-visible explanations.';

create index if not exists compound_dependencies_by_dependent_leg
  on public.compound_transaction_dependencies (dependent_leg_id, created_at asc);

create index if not exists compound_dependencies_by_dependency_leg
  on public.compound_transaction_dependencies (dependency_leg_id, created_at asc);

create or replace function public.compound_transaction_dependencies_validate_legs()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  dependency_ok boolean;
  dependent_ok boolean;
begin
  select exists (
    select 1
    from public.transaction_legs tl
    join public.transactions t on t.id = tl.transaction_id
    where tl.id = new.dependency_leg_id
      and t.compound_transaction_id = new.compound_transaction_id
  ) into dependency_ok;

  select exists (
    select 1
    from public.transaction_legs tl
    join public.transactions t on t.id = tl.transaction_id
    where tl.id = new.dependent_leg_id
      and t.compound_transaction_id = new.compound_transaction_id
  ) into dependent_ok;

  if not dependency_ok or not dependent_ok then
    raise exception 'COMPOUND_DEPENDENCY_LEG_OUT_OF_SCOPE'
      using hint = 'Both dependency legs must belong to transactions attached to the same compound_transaction_id';
  end if;

  return new;
end;
$$;

drop trigger if exists compound_transaction_dependencies_validate_legs_guard on public.compound_transaction_dependencies;
create trigger compound_transaction_dependencies_validate_legs_guard
  before insert or update on public.compound_transaction_dependencies
  for each row execute function public.compound_transaction_dependencies_validate_legs();

create or replace function public.compound_transaction_dependencies_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    raise exception 'COMPOUND_DEPENDENCIES_APPEND_ONLY'
      using hint = 'Insert a new dependency graph version instead of mutating existing saga graph evidence.';
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_compound_dependency_delete', true) <> 'true' then
      raise exception 'COMPOUND_DEPENDENCIES_DELETE_FORBIDDEN'
        using hint = 'Compound dependency edges are saga evidence; only retention/privacy jobs may delete them.';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists compound_transaction_dependencies_append_only_guard on public.compound_transaction_dependencies;
create trigger compound_transaction_dependencies_append_only_guard
  before update or delete on public.compound_transaction_dependencies
  for each row execute function public.compound_transaction_dependencies_append_only();

create table if not exists public.leg_status_events (
  id                       bigint generated by default as identity primary key,
  compound_transaction_id  uuid not null references public.compound_transactions(id) on delete cascade,
  transaction_id           uuid not null references public.transactions(id) on delete cascade,
  leg_id                   uuid not null references public.transaction_legs(id) on delete cascade,
  agent_id                 text not null check (
                             length(agent_id) between 1 and 120
                             and agent_id !~ '[[:space:]]'
                           ),
  capability_id            text not null check (
                             length(capability_id) between 1 and 120
                             and capability_id !~ '[[:space:]]'
                           ),
  status                   text not null check (
                             status in (
                               'pending',
                               'in_flight',
                               'committed',
                               'failed',
                               'rollback_pending',
                               'rolled_back',
                               'rollback_failed',
                               'manual_review'
                             )
                           ),
  provider_reference       text check (
                             provider_reference is null
                             or char_length(provider_reference) <= 240
                           ),
  evidence                 jsonb not null default '{}'::jsonb,
  "timestamp"              timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  check (jsonb_typeof(evidence) = 'object')
);

comment on table public.leg_status_events is
  'COMPOUND-EXEC-1 append-only SSE v2 event log. Replayed by created_at/id to reconstruct leg_status frames.';
comment on column public.leg_status_events.evidence is
  'Bounded status evidence only. Do not store raw provider payloads, payment data, prompts, or secrets.';

create index if not exists leg_status_events_by_compound_replay
  on public.leg_status_events (compound_transaction_id, "timestamp" asc, id asc);

create index if not exists leg_status_events_by_leg_time
  on public.leg_status_events (leg_id, "timestamp" asc, id asc);

create index if not exists leg_status_events_by_status_time
  on public.leg_status_events (status, "timestamp" desc);

create or replace function public.leg_status_events_validate_leg()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  leg_ok boolean;
begin
  select exists (
    select 1
    from public.transaction_legs tl
    join public.transactions t on t.id = tl.transaction_id
    where tl.id = new.leg_id
      and tl.transaction_id = new.transaction_id
      and t.compound_transaction_id = new.compound_transaction_id
  ) into leg_ok;

  if not leg_ok then
    raise exception 'LEG_STATUS_EVENT_OUT_OF_SCOPE'
      using hint = 'leg_id and transaction_id must belong to the supplied compound_transaction_id';
  end if;

  return new;
end;
$$;

drop trigger if exists leg_status_events_validate_leg_guard on public.leg_status_events;
create trigger leg_status_events_validate_leg_guard
  before insert or update on public.leg_status_events
  for each row execute function public.leg_status_events_validate_leg();

create or replace function public.leg_status_events_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    raise exception 'LEG_STATUS_EVENTS_APPEND_ONLY'
      using hint = 'Insert a new SSE v2 leg status event instead of mutating replay history.';
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_leg_status_event_delete', true) <> 'true' then
      raise exception 'LEG_STATUS_EVENTS_DELETE_FORBIDDEN'
        using hint = 'Leg status events are execution evidence; only retention/privacy jobs may delete them.';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists leg_status_events_append_only_guard on public.leg_status_events;
create trigger leg_status_events_append_only_guard
  before update or delete on public.leg_status_events
  for each row execute function public.leg_status_events_append_only();

alter table public.compound_transactions enable row level security;
alter table public.compound_transaction_dependencies enable row level security;
alter table public.leg_status_events enable row level security;

revoke all on public.compound_transactions from anon, authenticated;
revoke all on public.compound_transaction_dependencies from anon, authenticated;
revoke all on public.leg_status_events from anon, authenticated;

grant all on public.compound_transactions to service_role;
grant all on public.compound_transaction_dependencies to service_role;
grant all on public.leg_status_events to service_role;
grant usage, select on sequence public.leg_status_events_id_seq to service_role;

grant select on public.compound_transactions to authenticated;
grant select on public.compound_transaction_dependencies to authenticated;
grant select on public.leg_status_events to authenticated;

drop policy if exists compound_transactions_select_own on public.compound_transactions;
create policy compound_transactions_select_own on public.compound_transactions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists compound_dependencies_select_own on public.compound_transaction_dependencies;
create policy compound_dependencies_select_own on public.compound_transaction_dependencies
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.compound_transactions ct
      where ct.id = compound_transaction_dependencies.compound_transaction_id
        and ct.user_id = (select auth.uid())
    )
  );

drop policy if exists leg_status_events_select_own on public.leg_status_events;
create policy leg_status_events_select_own on public.leg_status_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.compound_transactions ct
      where ct.id = leg_status_events.compound_transaction_id
        and ct.user_id = (select auth.uid())
    )
  );
