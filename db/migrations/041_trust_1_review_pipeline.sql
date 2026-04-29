-- Migration 041 — TRUST-1 review pipeline substrate.
--
-- Implements docs/specs/sprint-4-trust-1-review-pipeline.md:
--   - unified reviewer queue for submissions, promotions, identity checks, and demotions
--   - append-only reviewer decision log
--   - continuous-monitoring health signal rollups
--   - developer ECDSA-P256 public keys and revocation audit
--   - signing-key references on marketplace agent versions
--
-- Rollback:
--   alter table public.marketplace_agent_versions drop constraint if exists marketplace_agent_versions_signature_key_pair;
--   alter table public.marketplace_agent_versions drop column if exists signature_verification_error;
--   alter table public.marketplace_agent_versions drop column if exists signature_verified_at;
--   alter table public.marketplace_agent_versions drop column if exists signature_algorithm;
--   alter table public.marketplace_agent_versions drop column if exists signing_key_id;
--   alter table public.marketplace_agent_versions drop column if exists signer_user_id;
--   drop trigger if exists agent_review_queue_touch_updated_at on public.agent_review_queue;
--   drop trigger if exists agent_review_queue_state_guard on public.agent_review_queue;
--   drop trigger if exists agent_review_decisions_append_only_guard on public.agent_review_decisions;
--   drop trigger if exists agent_health_signals_touch_updated_at on public.agent_health_signals;
--   drop trigger if exists developer_keys_touch_updated_at on public.developer_keys;
--   drop trigger if exists developer_keys_state_guard on public.developer_keys;
--   drop trigger if exists developer_key_revocations_append_only_guard on public.developer_key_revocations;
--   drop function if exists public.agent_review_queue_guard();
--   drop function if exists public.agent_review_decisions_append_only();
--   drop function if exists public.developer_keys_guard();
--   drop function if exists public.developer_key_revocations_append_only();
--   drop index if exists public.agent_review_queue_pending_sla;
--   drop index if exists public.agent_review_queue_by_source_submission;
--   drop index if exists public.agent_review_queue_by_promotion_request;
--   drop index if exists public.agent_review_queue_by_identity_user;
--   drop index if exists public.agent_review_decisions_by_queue;
--   drop index if exists public.agent_health_signals_by_agent_window;
--   drop index if exists public.agent_health_signals_open_incidents;
--   drop index if exists public.developer_keys_active_by_user;
--   drop index if exists public.developer_keys_fingerprint_unique;
--   drop index if exists public.developer_key_revocations_by_user;
--   drop table if exists public.developer_key_revocations;
--   drop table if exists public.developer_keys;
--   drop table if exists public.agent_health_signals;
--   drop table if exists public.agent_review_decisions;
--   drop table if exists public.agent_review_queue;

alter table public.marketplace_agent_versions
  add column if not exists signer_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists signing_key_id text,
  add column if not exists signature_algorithm text not null default 'ecdsa-p256'
    check (signature_algorithm in ('ecdsa-p256')),
  add column if not exists signature_verified_at timestamptz,
  add column if not exists signature_verification_error text;

alter table public.marketplace_agent_versions
  drop constraint if exists marketplace_agent_versions_signature_key_pair;

alter table public.marketplace_agent_versions
  add constraint marketplace_agent_versions_signature_key_pair
  check (
    (signer_user_id is null and signing_key_id is null)
    or (signer_user_id is not null and signing_key_id is not null)
  );

create table if not exists public.agent_review_queue (
  id                  uuid primary key default gen_random_uuid(),
  request_type        text not null check (request_type in (
                        'submission',
                        'promotion',
                        'identity_verification',
                        'demotion_review'
                      )),
  agent_id            text,
  agent_version       text,
  promotion_request_id bigint references public.developer_promotion_requests(id) on delete cascade,
  identity_user_id    uuid references public.profiles(id) on delete cascade,
  target_tier         text check (target_tier is null or target_tier in (
                        'official',
                        'verified',
                        'community',
                        'experimental'
                      )),
  state               text not null default 'pending' check (state in (
                        'pending',
                        'in_review',
                        'approved',
                        'rejected',
                        'needs_changes',
                        'withdrawn'
                      )),
  priority            text not null default 'normal' check (priority in ('low','normal','high','p0')),
  sla_due_at          timestamptz not null,
  submitted_at        timestamptz not null default now(),
  assigned_to         uuid references public.profiles(id) on delete set null,
  automated_checks    jsonb not null default '{}'::jsonb,
  eligibility_report  jsonb not null default '{}'::jsonb,
  health_report       jsonb not null default '{}'::jsonb,
  decision_note       text,
  decided_by          uuid references public.profiles(id) on delete set null,
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (agent_id, agent_version)
    references public.marketplace_agent_versions(agent_id, version)
    on delete cascade,
  check (
    (request_type = 'submission'
      and agent_id is not null
      and agent_version is not null
      and promotion_request_id is null
      and identity_user_id is null)
    or (request_type = 'promotion'
      and agent_id is not null
      and agent_version is not null
      and promotion_request_id is not null
      and identity_user_id is null
      and target_tier is not null)
    or (request_type = 'identity_verification'
      and agent_id is null
      and agent_version is null
      and promotion_request_id is null
      and identity_user_id is not null)
    or (request_type = 'demotion_review'
      and agent_id is not null
      and agent_version is not null
      and promotion_request_id is null
      and identity_user_id is null)
  ),
  check (
    (state in ('pending','in_review') and decided_at is null)
    or (state in ('approved','rejected','needs_changes','withdrawn') and decided_at is not null)
  )
);

comment on table public.agent_review_queue is
  'TRUST-1 unified reviewer queue. Requests come from marketplace submissions, DEV-DASH promotion requests, identity checks, and health-monitor demotion reviews.';
comment on column public.agent_review_queue.automated_checks is
  'Cached five-check pipeline report. Shape is owned by apps/web/lib/trust/check-pipeline.ts.';
comment on column public.agent_review_queue.eligibility_report is
  'Promotion or identity eligibility details used by reviewer UI and DEV-DASH.';

create index if not exists agent_review_queue_pending_sla
  on public.agent_review_queue (sla_due_at asc, priority desc, submitted_at asc)
  where state in ('pending','in_review');

create unique index if not exists agent_review_queue_by_source_submission
  on public.agent_review_queue (agent_id, agent_version, request_type)
  where request_type in ('submission','demotion_review') and state in ('pending','in_review');

create unique index if not exists agent_review_queue_by_promotion_request
  on public.agent_review_queue (promotion_request_id)
  where promotion_request_id is not null;

create unique index if not exists agent_review_queue_by_identity_user
  on public.agent_review_queue (identity_user_id)
  where request_type = 'identity_verification' and state in ('pending','in_review');

drop trigger if exists agent_review_queue_touch_updated_at on public.agent_review_queue;
create trigger agent_review_queue_touch_updated_at
  before update on public.agent_review_queue
  for each row execute function public.touch_updated_at();

create or replace function public.agent_review_queue_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    if old.id is distinct from new.id
       or old.request_type is distinct from new.request_type
       or old.agent_id is distinct from new.agent_id
       or old.agent_version is distinct from new.agent_version
       or old.promotion_request_id is distinct from new.promotion_request_id
       or old.identity_user_id is distinct from new.identity_user_id
       or old.target_tier is distinct from new.target_tier
       or old.submitted_at is distinct from new.submitted_at
       or old.created_at is distinct from new.created_at then
      raise exception 'AGENT_REVIEW_QUEUE_IDENTITY_IMMUTABLE'
        using hint = 'Create a new review queue row instead of changing the source identity';
    end if;

    if old.state in ('approved','rejected','needs_changes','withdrawn') then
      raise exception 'AGENT_REVIEW_QUEUE_DECISION_IMMUTABLE'
        using hint = 'Reviewer queue decisions are retained; append a new queue row for new work';
    end if;

    if old.state in ('pending','in_review')
       and new.state in ('approved','rejected','needs_changes','withdrawn')
       and (new.decided_at is null or new.decided_by is null) then
      raise exception 'AGENT_REVIEW_QUEUE_DECISION_REQUIRES_ATTRIBUTION';
    end if;

    return new;
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_agent_review_queue_delete', true) <> 'true' then
      raise exception 'AGENT_REVIEW_QUEUE_APPEND_ONLY'
        using hint = 'Review queue rows are audit evidence; only account-deletion cascade may remove rows';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists agent_review_queue_state_guard on public.agent_review_queue;
create trigger agent_review_queue_state_guard
  before update or delete on public.agent_review_queue
  for each row execute function public.agent_review_queue_guard();

create table if not exists public.agent_review_decisions (
  id             bigint generated by default as identity primary key,
  queue_id       uuid not null references public.agent_review_queue(id) on delete cascade,
  reviewer_id    uuid references public.profiles(id) on delete set null,
  reviewer_email text,
  outcome        text not null check (outcome in ('approve','reject','needs_changes','withdraw')),
  reason_codes   text[] not null default '{}'::text[],
  notes          text,
  evidence       jsonb not null default '{}'::jsonb,
  decided_at     timestamptz not null default now(),
  check (reviewer_id is not null or reviewer_email is not null),
  check (cardinality(reason_codes) > 0 or outcome = 'approve')
);

comment on table public.agent_review_decisions is
  'TRUST-1 append-only reviewer decision log. Queue state is denormalized for fast UI but this table is the audit source.';

create index if not exists agent_review_decisions_by_queue
  on public.agent_review_decisions (queue_id, decided_at desc);

create or replace function public.agent_review_decisions_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('lumo.allow_agent_review_decision_delete', true) <> 'true' then
    raise exception 'AGENT_REVIEW_DECISIONS_APPEND_ONLY'
      using hint = 'Reviewer decisions are append-only audit evidence';
  end if;
  return old;
end;
$$;

drop trigger if exists agent_review_decisions_append_only_guard on public.agent_review_decisions;
create trigger agent_review_decisions_append_only_guard
  before update or delete on public.agent_review_decisions
  for each row execute function public.agent_review_decisions_append_only();

create table if not exists public.agent_health_signals (
  agent_id                  text not null,
  agent_version             text not null,
  window_label              text not null check (window_label in ('24h','7d','30d')),
  window_start              timestamptz not null,
  window_end                timestamptz not null,
  invocation_count          integer not null default 0 check (invocation_count >= 0),
  error_count               integer not null default 0 check (error_count >= 0),
  scope_denied_count        integer not null default 0 check (scope_denied_count >= 0),
  cost_outlier_count        integer not null default 0 check (cost_outlier_count >= 0),
  security_flag_count       integer not null default 0 check (security_flag_count >= 0),
  unique_users              integer not null default 0 check (unique_users >= 0),
  total_cost_usd            numeric(12,6) not null default 0 check (total_cost_usd >= 0),
  error_rate                numeric(8,6) not null default 0 check (error_rate >= 0 and error_rate <= 1),
  scope_denied_rate         numeric(8,6) not null default 0 check (scope_denied_rate >= 0 and scope_denied_rate <= 1),
  cost_outlier_rate         numeric(8,6) not null default 0 check (cost_outlier_rate >= 0 and cost_outlier_rate <= 1),
  severity                  text not null default 'info' check (severity in ('info','P3','P2','P1','P0')),
  recommended_action        text not null default 'none' check (recommended_action in (
                              'none',
                              'demotion_review',
                              'auto_kill'
                            )),
  evidence                  jsonb not null default '{}'::jsonb,
  computed_at               timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (agent_id, agent_version, window_label, window_end),
  foreign key (agent_id, agent_version)
    references public.marketplace_agent_versions(agent_id, version)
    on delete cascade,
  check (window_end > window_start),
  check (error_count <= invocation_count),
  check (cost_outlier_count <= invocation_count)
);

comment on table public.agent_health_signals is
  'TRUST-1 continuous-monitoring rollup. Cron upserts one row per agent/version/window_end and enqueues demotion or auto-kill actions from thresholds.';

create index if not exists agent_health_signals_by_agent_window
  on public.agent_health_signals (agent_id, agent_version, window_end desc);

create index if not exists agent_health_signals_open_incidents
  on public.agent_health_signals (recommended_action, severity, computed_at desc)
  where recommended_action <> 'none';

drop trigger if exists agent_health_signals_touch_updated_at on public.agent_health_signals;
create trigger agent_health_signals_touch_updated_at
  before update on public.agent_health_signals
  for each row execute function public.touch_updated_at();

create table if not exists public.developer_keys (
  user_id            uuid not null references public.profiles(id) on delete cascade,
  key_id             text not null,
  public_key_pem     text not null,
  public_key_jwk     jsonb,
  algorithm          text not null default 'ecdsa-p256' check (algorithm in ('ecdsa-p256')),
  fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  label              text,
  state              text not null default 'active' check (state in ('active','revoked')),
  registered_at      timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (user_id, key_id),
  check (key_id ~ '^[a-zA-Z0-9:_-]{8,96}$'),
  check (state = 'active' or revoked_at is not null)
);

comment on table public.developer_keys is
  'TRUST-1 author public keys. Private keys live only in the developer OS keychain; Lumo stores public verification material.';
comment on column public.developer_keys.fingerprint_sha256 is
  'SHA-256 fingerprint of the canonical public key material; unique across active and revoked keys for incident triage.';

create index if not exists developer_keys_active_by_user
  on public.developer_keys (user_id, registered_at desc)
  where state = 'active';

create unique index if not exists developer_keys_fingerprint_unique
  on public.developer_keys (fingerprint_sha256);

drop trigger if exists developer_keys_touch_updated_at on public.developer_keys;
create trigger developer_keys_touch_updated_at
  before update on public.developer_keys
  for each row execute function public.touch_updated_at();

create or replace function public.developer_keys_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    if old.user_id is distinct from new.user_id
       or old.key_id is distinct from new.key_id
       or old.public_key_pem is distinct from new.public_key_pem
       or old.public_key_jwk is distinct from new.public_key_jwk
       or old.algorithm is distinct from new.algorithm
       or old.fingerprint_sha256 is distinct from new.fingerprint_sha256
       or old.registered_at is distinct from new.registered_at
       or old.created_at is distinct from new.created_at then
      raise exception 'DEVELOPER_KEY_IDENTITY_IMMUTABLE'
        using hint = 'Register a new key instead of changing public key material';
    end if;

    if old.state = 'revoked' and new.state <> 'revoked' then
      raise exception 'DEVELOPER_KEY_REVOCATION_IMMUTABLE'
        using hint = 'A revoked developer key cannot be reactivated';
    end if;

    if old.state = 'active' and new.state = 'revoked' and new.revoked_at is null then
      raise exception 'DEVELOPER_KEY_REVOCATION_REQUIRES_TIMESTAMP';
    end if;

    return new;
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_developer_key_delete', true) <> 'true' then
      raise exception 'DEVELOPER_KEYS_APPEND_ONLY'
        using hint = 'Developer keys are retained for signature audit; use state=revoked';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists developer_keys_state_guard on public.developer_keys;
create trigger developer_keys_state_guard
  before update or delete on public.developer_keys
  for each row execute function public.developer_keys_guard();

create table if not exists public.developer_key_revocations (
  id               bigint generated by default as identity primary key,
  user_id          uuid not null,
  key_id           text not null,
  revoked_by       uuid references public.profiles(id) on delete set null,
  revoked_at       timestamptz not null default now(),
  reason           text not null,
  versions_yanked  integer not null default 0 check (versions_yanked >= 0),
  evidence         jsonb not null default '{}'::jsonb,
  foreign key (user_id, key_id)
    references public.developer_keys(user_id, key_id)
    on delete cascade,
  check (char_length(trim(reason)) > 0)
);

comment on table public.developer_key_revocations is
  'TRUST-1 append-only key revocation log. Revocation can trigger marketplace version yanks and reviewer triage.';

create index if not exists developer_key_revocations_by_user
  on public.developer_key_revocations (user_id, revoked_at desc);

create or replace function public.developer_key_revocations_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('lumo.allow_developer_key_revocation_delete', true) <> 'true' then
    raise exception 'DEVELOPER_KEY_REVOCATIONS_APPEND_ONLY'
      using hint = 'Key revocations are append-only incident evidence';
  end if;
  return old;
end;
$$;

drop trigger if exists developer_key_revocations_append_only_guard on public.developer_key_revocations;
create trigger developer_key_revocations_append_only_guard
  before update or delete on public.developer_key_revocations
  for each row execute function public.developer_key_revocations_append_only();

alter table public.agent_review_queue enable row level security;
alter table public.agent_review_decisions enable row level security;
alter table public.agent_health_signals enable row level security;
alter table public.developer_keys enable row level security;
alter table public.developer_key_revocations enable row level security;

revoke all on public.agent_review_queue from anon, authenticated;
revoke all on public.agent_review_decisions from anon, authenticated;
revoke all on public.agent_health_signals from anon, authenticated;
revoke all on public.developer_keys from anon, authenticated;
revoke all on public.developer_key_revocations from anon, authenticated;

grant all on public.agent_review_queue to service_role;
grant all on public.agent_review_decisions to service_role;
grant all on public.agent_health_signals to service_role;
grant all on public.developer_keys to service_role;
grant all on public.developer_key_revocations to service_role;

grant usage, select on sequence public.agent_review_decisions_id_seq to service_role;
grant usage, select on sequence public.developer_key_revocations_id_seq to service_role;

grant select on public.developer_keys to authenticated;
grant select on public.developer_key_revocations to authenticated;

drop policy if exists developer_keys_self_read on public.developer_keys;
create policy developer_keys_self_read on public.developer_keys
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists developer_key_revocations_self_read on public.developer_key_revocations;
create policy developer_key_revocations_self_read on public.developer_key_revocations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
