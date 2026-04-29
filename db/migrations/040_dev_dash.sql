-- Migration 040 — DEV-DASH developer dashboard substrate.
--
-- Implements docs/specs/sprint-4-dev-dash.md:
--   - author profiles and identity verification state
--   - promotion request state machine for TRUST-1 review
--   - developer webhook registrations
--   - per-agent hourly metrics rollup surface
--   - author-read policies over marketplace rows they own
--
-- Rollback:
--   drop view if exists public.developer_agents_view;
--   drop trigger if exists developer_profiles_touch_updated_at on public.developer_profiles;
--   drop trigger if exists developer_identity_verifications_touch_updated_at on public.developer_identity_verifications;
--   drop trigger if exists developer_promotion_requests_touch_updated_at on public.developer_promotion_requests;
--   drop trigger if exists developer_promotion_requests_state_guard on public.developer_promotion_requests;
--   drop trigger if exists developer_webhooks_touch_updated_at on public.developer_webhooks;
--   drop function if exists public.developer_promotion_requests_guard();
--   drop index if exists developer_profiles_by_email;
--   drop index if exists developer_identity_verifications_by_tier;
--   drop index if exists developer_promotion_requests_open;
--   drop index if exists developer_promotion_requests_by_agent;
--   drop index if exists developer_webhooks_active_by_user;
--   drop index if exists developer_agent_metrics_hourly_by_agent_recent;
--   drop table if exists public.developer_agent_metrics_hourly;
--   drop table if exists public.developer_webhooks;
--   drop table if exists public.developer_promotion_requests;
--   drop table if exists public.developer_identity_verifications;
--   drop table if exists public.developer_profiles;

create table if not exists public.developer_profiles (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  display_name text not null,
  contact_email text,
  homepage     text,
  avatar_url   text,
  bio          text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (char_length(trim(display_name)) > 0),
  check (homepage is null or homepage ~* '^https://')
);

comment on table public.developer_profiles is
  'DEV-DASH public-ish author profile. Keyed by Lumo user id; marketplace ownership still derives from marketplace_agents.author_email.';
comment on column public.developer_profiles.contact_email is
  'Optional author contact email shown in developer surfaces. Marketplace ownership is derived from profiles.email / marketplace_agents.author_email.';

create index if not exists developer_profiles_by_email
  on public.developer_profiles (lower(contact_email))
  where contact_email is not null;

drop trigger if exists developer_profiles_touch_updated_at on public.developer_profiles;
create trigger developer_profiles_touch_updated_at
  before update on public.developer_profiles
  for each row execute function public.touch_updated_at();

create table if not exists public.developer_identity_verifications (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  verification_tier   text not null default 'unverified'
    check (verification_tier in ('unverified','email_verified','legal_entity_verified')),
  review_state        text not null default 'not_submitted'
    check (review_state in ('not_submitted','pending','approved','rejected','needs_changes')),
  legal_entity_name   text,
  registration_number text,
  registration_country text,
  document_path       text,
  evidence            jsonb not null default '{}'::jsonb,
  submitted_at        timestamptz,
  verified_at         timestamptz,
  verifier            text,
  rejection_reason    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (
    verification_tier <> 'legal_entity_verified'
    or (review_state = 'approved' and verified_at is not null)
  ),
  check (
    review_state <> 'pending'
    or (legal_entity_name is not null and document_path is not null and submitted_at is not null)
  ),
  check (registration_country is null or registration_country ~ '^[A-Z]{2}$')
);

comment on table public.developer_identity_verifications is
  'DEV-DASH identity ladder. email_verified is enough for community; legal_entity_verified is required for verified promotion.';
comment on column public.developer_identity_verifications.evidence is
  'Structured legal entity evidence metadata. Raw documents live in storage and are referenced by document_path.';

create index if not exists developer_identity_verifications_by_tier
  on public.developer_identity_verifications (verification_tier, review_state, updated_at desc);

drop trigger if exists developer_identity_verifications_touch_updated_at on public.developer_identity_verifications;
create trigger developer_identity_verifications_touch_updated_at
  before update on public.developer_identity_verifications
  for each row execute function public.touch_updated_at();

create table if not exists public.developer_promotion_requests (
  id            bigint generated by default as identity primary key,
  agent_id      text not null references public.marketplace_agents(agent_id) on delete cascade,
  agent_version text not null,
  requested_by  uuid not null references public.profiles(id) on delete cascade,
  target_tier   text not null check (target_tier in ('community','verified','official')),
  state         text not null default 'pending'
    check (state in ('pending','approved','rejected','withdrawn')),
  reason        text,
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  submitted_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (agent_id, agent_version)
    references public.marketplace_agent_versions(agent_id, version)
    on delete cascade,
  check (
    (state = 'pending' and decided_at is null)
    or (state <> 'pending' and decided_at is not null)
  )
);

comment on table public.developer_promotion_requests is
  'DEV-DASH author-side trust-tier promotion request. TRUST-1 reviewer queue owns final decisions.';
comment on column public.developer_promotion_requests.reason is
  'Author-supplied promotion request rationale.';
comment on column public.developer_promotion_requests.decision_note is
  'Reviewer decision note. Immutable after a request leaves pending.';

create unique index if not exists developer_promotion_requests_one_pending
  on public.developer_promotion_requests (agent_id, target_tier)
  where state = 'pending';

create index if not exists developer_promotion_requests_open
  on public.developer_promotion_requests (state, submitted_at)
  where state = 'pending';

create index if not exists developer_promotion_requests_by_agent
  on public.developer_promotion_requests (agent_id, submitted_at desc);

drop trigger if exists developer_promotion_requests_touch_updated_at on public.developer_promotion_requests;
create trigger developer_promotion_requests_touch_updated_at
  before update on public.developer_promotion_requests
  for each row execute function public.touch_updated_at();

create or replace function public.developer_promotion_requests_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    if old.id is distinct from new.id
       or old.agent_id is distinct from new.agent_id
       or old.agent_version is distinct from new.agent_version
       or old.requested_by is distinct from new.requested_by
       or old.target_tier is distinct from new.target_tier
       or old.submitted_at is distinct from new.submitted_at then
      raise exception 'DEVELOPER_PROMOTION_IDENTITY_IMMUTABLE'
        using hint = 'Append a new promotion request instead of changing identity fields';
    end if;

    if old.state <> 'pending' then
      raise exception 'DEVELOPER_PROMOTION_DECISION_IMMUTABLE'
        using hint = 'Promotion decisions are append-only after leaving pending';
    end if;

    if old.state = 'pending' and new.state <> 'pending' and new.decided_at is null then
      raise exception 'DEVELOPER_PROMOTION_DECISION_REQUIRES_TIMESTAMP';
    end if;

    return new;
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_developer_promotion_delete', true) <> 'true' then
      raise exception 'DEVELOPER_PROMOTION_APPEND_ONLY'
        using hint = 'Promotion requests are retained for review audit; only account-deletion cascade may remove rows';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists developer_promotion_requests_state_guard on public.developer_promotion_requests;
create trigger developer_promotion_requests_state_guard
  before update or delete on public.developer_promotion_requests
  for each row execute function public.developer_promotion_requests_guard();

create table if not exists public.developer_webhooks (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  label               text not null,
  url                 text not null,
  event_types         text[] not null default array['install_completed','uninstall_completed']::text[],
  active              boolean not null default true,
  secret_token_hash   text,
  last_delivery_at    timestamptz,
  last_delivery_state text check (last_delivery_state is null or last_delivery_state in ('ok','failed')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (char_length(trim(label)) > 0),
  check (url ~* '^https://'),
  check (cardinality(event_types) > 0),
  check (
    event_types <@ array[
      'view',
      'install_started',
      'install_completed',
      'uninstall_completed',
      'version_published',
      'version_yanked',
      'promotion_decided',
      'transaction_completed'
    ]::text[]
  )
);

comment on table public.developer_webhooks is
  'DEV-DASH webhook registrations only. Delivery workers land after this sprint.';
comment on column public.developer_webhooks.secret_token_hash is
  'Optional hashed signing secret. Raw webhook secrets are never stored.';

create index if not exists developer_webhooks_active_by_user
  on public.developer_webhooks (user_id, updated_at desc)
  where active = true;

drop trigger if exists developer_webhooks_touch_updated_at on public.developer_webhooks;
create trigger developer_webhooks_touch_updated_at
  before update on public.developer_webhooks
  for each row execute function public.touch_updated_at();

create table if not exists public.developer_agent_metrics_hourly (
  agent_id                  text not null references public.marketplace_agents(agent_id) on delete cascade,
  agent_version             text not null,
  hour                      timestamptz not null,
  install_delta             integer not null default 0 check (install_delta >= 0),
  invocation_count          integer not null default 0 check (invocation_count >= 0),
  error_count               integer not null default 0 check (error_count >= 0),
  p95_latency_ms            integer check (p95_latency_ms is null or p95_latency_ms >= 0),
  p99_latency_ms            integer check (p99_latency_ms is null or p99_latency_ms >= 0),
  median_cost_usd           numeric(12,6) check (median_cost_usd is null or median_cost_usd >= 0),
  p95_cost_usd              numeric(12,6) check (p95_cost_usd is null or p95_cost_usd >= 0),
  total_cost_usd            numeric(12,6) not null default 0 check (total_cost_usd >= 0),
  developer_share_usd       numeric(12,6) not null default 0 check (developer_share_usd >= 0),
  top_capabilities          jsonb not null default '[]'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (agent_id, agent_version, hour),
  foreign key (agent_id, agent_version)
    references public.marketplace_agent_versions(agent_id, version)
    on delete cascade,
  check (date_trunc('hour', hour) = hour),
  check (error_count <= invocation_count),
  check (developer_share_usd <= total_cost_usd)
);

comment on table public.developer_agent_metrics_hourly is
  'DEV-DASH hourly per-agent rollup. Cron uses a two-hour overlap and UPSERT for late-arriving invocation rows.';

create index if not exists developer_agent_metrics_hourly_by_agent_recent
  on public.developer_agent_metrics_hourly (agent_id, hour desc);

drop trigger if exists developer_agent_metrics_hourly_touch_updated_at on public.developer_agent_metrics_hourly;
create trigger developer_agent_metrics_hourly_touch_updated_at
  before update on public.developer_agent_metrics_hourly
  for each row execute function public.touch_updated_at();

alter table public.developer_profiles enable row level security;
alter table public.developer_identity_verifications enable row level security;
alter table public.developer_promotion_requests enable row level security;
alter table public.developer_webhooks enable row level security;
alter table public.developer_agent_metrics_hourly enable row level security;

revoke all on public.developer_profiles from anon, authenticated;
revoke all on public.developer_identity_verifications from anon, authenticated;
revoke all on public.developer_promotion_requests from anon, authenticated;
revoke all on public.developer_webhooks from anon, authenticated;
revoke all on public.developer_agent_metrics_hourly from anon, authenticated;

grant all on public.developer_profiles to service_role;
grant all on public.developer_identity_verifications to service_role;
grant all on public.developer_promotion_requests to service_role;
grant all on public.developer_webhooks to service_role;
grant all on public.developer_agent_metrics_hourly to service_role;

grant usage, select on sequence public.developer_promotion_requests_id_seq to service_role;

grant select, insert, update on public.developer_profiles to authenticated;
grant select, insert, update on public.developer_identity_verifications to authenticated;
grant select, insert, update on public.developer_promotion_requests to authenticated;
grant select, insert, update on public.developer_webhooks to authenticated;
grant select on public.developer_agent_metrics_hourly to authenticated;

drop policy if exists developer_profiles_self on public.developer_profiles;
create policy developer_profiles_self on public.developer_profiles
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists developer_identity_self_read on public.developer_identity_verifications;
create policy developer_identity_self_read on public.developer_identity_verifications
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists developer_identity_self_submit on public.developer_identity_verifications;
create policy developer_identity_self_submit on public.developer_identity_verifications
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and verification_tier in ('unverified','email_verified')
    and review_state in ('not_submitted','pending')
    and verified_at is null
    and verifier is null
  );

drop policy if exists developer_identity_self_update_pending on public.developer_identity_verifications;
create policy developer_identity_self_update_pending on public.developer_identity_verifications
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and verification_tier in ('unverified','email_verified')
    and review_state in ('not_submitted','pending')
    and verified_at is null
    and verifier is null
  );

drop policy if exists developer_promotions_self_read on public.developer_promotion_requests;
create policy developer_promotions_self_read on public.developer_promotion_requests
  for select
  to authenticated
  using ((select auth.uid()) = requested_by);

drop policy if exists developer_promotions_self_insert on public.developer_promotion_requests;
create policy developer_promotions_self_insert on public.developer_promotion_requests
  for insert
  to authenticated
  with check (
    (select auth.uid()) = requested_by
    and state = 'pending'
    and decided_by is null
    and decided_at is null
    and exists (
      select 1
      from public.marketplace_agents ma
      join public.profiles p on p.id = (select auth.uid())
      where ma.agent_id = developer_promotion_requests.agent_id
        and lower(coalesce(ma.author_email, '')) = lower(coalesce(p.email, ''))
    )
  );

drop policy if exists developer_promotions_self_withdraw on public.developer_promotion_requests;
create policy developer_promotions_self_withdraw on public.developer_promotion_requests
  for update
  to authenticated
  using ((select auth.uid()) = requested_by and state = 'pending')
  with check (
    (select auth.uid()) = requested_by
    and state = 'withdrawn'
    and decided_by = (select auth.uid())
    and decided_at is not null
  );

drop policy if exists developer_webhooks_self on public.developer_webhooks;
create policy developer_webhooks_self on public.developer_webhooks
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists developer_agent_metrics_author_read on public.developer_agent_metrics_hourly;
create policy developer_agent_metrics_author_read on public.developer_agent_metrics_hourly
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.marketplace_agents ma
      join public.profiles p on p.id = (select auth.uid())
      where ma.agent_id = developer_agent_metrics_hourly.agent_id
        and lower(coalesce(ma.author_email, '')) = lower(coalesce(p.email, ''))
    )
  );

grant select on public.marketplace_agent_versions to authenticated;
grant select on public.agent_security_reviews to authenticated;
grant select on public.marketplace_install_metrics to authenticated;

drop policy if exists marketplace_agents_author_read on public.marketplace_agents;
create policy marketplace_agents_author_read on public.marketplace_agents
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and lower(coalesce(p.email, '')) = lower(coalesce(marketplace_agents.author_email, ''))
    )
  );

drop policy if exists marketplace_versions_author_read on public.marketplace_agent_versions;
create policy marketplace_versions_author_read on public.marketplace_agent_versions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.marketplace_agents ma
      join public.profiles p on p.id = (select auth.uid())
      where ma.agent_id = marketplace_agent_versions.agent_id
        and lower(coalesce(ma.author_email, '')) = lower(coalesce(p.email, ''))
    )
  );

drop policy if exists security_reviews_author_read on public.agent_security_reviews;
create policy security_reviews_author_read on public.agent_security_reviews
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.marketplace_agents ma
      join public.profiles p on p.id = (select auth.uid())
      where ma.agent_id = agent_security_reviews.agent_id
        and lower(coalesce(ma.author_email, '')) = lower(coalesce(p.email, ''))
    )
  );

drop policy if exists install_metrics_author_read on public.marketplace_install_metrics;
create policy install_metrics_author_read on public.marketplace_install_metrics
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.marketplace_agents ma
      join public.profiles p on p.id = (select auth.uid())
      where ma.agent_id = marketplace_install_metrics.agent_id
        and lower(coalesce(ma.author_email, '')) = lower(coalesce(p.email, ''))
    )
  );

create or replace view public.developer_agents_view
with (security_invoker = true)
as
select
  ma.agent_id,
  ma.current_version,
  ma.trust_tier,
  ma.state,
  ma.killed,
  ma.category,
  ma.install_count,
  ma.install_velocity_7d,
  ma.rating_avg,
  ma.rating_count,
  ma.price_usd,
  ma.billing_period,
  ma.revenue_split_pct,
  ma.author_email,
  ma.author_name,
  ma.author_url,
  ma.published_at,
  ma.updated_at,
  p.id as author_user_id
from public.marketplace_agents ma
left join public.profiles p
  on lower(coalesce(p.email, '')) = lower(coalesce(ma.author_email, ''));

comment on view public.developer_agents_view is
  'DEV-DASH author-facing marketplace row view. SECURITY INVOKER keeps marketplace RLS policies active.';

grant select on public.developer_agents_view to authenticated;
