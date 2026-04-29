-- Migration 043 — MERCHANT-1 merchant-of-record substrate.
--
-- Implements docs/specs/adr-017-merchant-of-record-agent-track.md:
--   - provider credential metadata vault
--   - Stripe customer/payment-method mirrors
--   - ECDSA-P256 device confirmation keys
--   - merchant transaction and transaction-leg ledgers
--   - Stripe webhook idempotency ledger
--
-- Rollback:
--   drop trigger if exists merchant_provider_credentials_touch_updated_at on public.merchant_provider_credentials;
--   drop trigger if exists payments_customers_touch_updated_at on public.payments_customers;
--   drop trigger if exists payment_methods_touch_updated_at on public.payment_methods;
--   drop trigger if exists confirmation_keys_touch_updated_at on public.confirmation_keys;
--   drop trigger if exists confirmation_keys_state_guard on public.confirmation_keys;
--   drop trigger if exists transactions_touch_updated_at on public.transactions;
--   drop trigger if exists transactions_retry_safe_guard on public.transactions;
--   drop trigger if exists transaction_legs_touch_updated_at on public.transaction_legs;
--   drop trigger if exists transaction_legs_retry_safe_guard on public.transaction_legs;
--   drop trigger if exists stripe_webhook_events_touch_updated_at on public.stripe_webhook_events;
--   drop function if exists public.confirmation_keys_guard();
--   drop function if exists public.transactions_retry_safe_append_only();
--   drop function if exists public.transaction_legs_retry_safe_append_only();
--   drop index if exists public.merchant_provider_credentials_active_by_provider;
--   drop index if exists public.payment_methods_by_user_attached;
--   drop index if exists public.payment_methods_one_default_per_user;
--   drop index if exists public.confirmation_keys_active_by_user;
--   drop index if exists public.transactions_by_user_created;
--   drop index if exists public.transactions_by_mission_step;
--   drop index if exists public.transactions_by_payment_intent;
--   drop index if exists public.transactions_open_by_provider;
--   drop index if exists public.transaction_legs_by_transaction_order;
--   drop index if exists public.transaction_legs_by_mission_step;
--   drop index if exists public.transaction_legs_open_by_provider;
--   drop index if exists public.stripe_webhook_events_by_type_created;
--   drop table if exists public.stripe_webhook_events;
--   drop table if exists public.transaction_legs;
--   drop table if exists public.transactions;
--   drop table if exists public.confirmation_keys;
--   drop table if exists public.payment_methods;
--   drop table if exists public.payments_customers;
--   drop table if exists public.merchant_provider_credentials;

create table if not exists public.merchant_provider_credentials (
  id                   uuid primary key default gen_random_uuid(),
  provider             text not null check (provider in (
                         'duffel',
                         'booking',
                         'expedia_partner_solutions',
                         'uber_for_business',
                         'stripe_issuing',
                         'stripe_payments',
                         'mock_merchant'
                       )),
  environment          text not null check (environment in ('test','production')),
  credential_kind      text not null check (
                         credential_kind in ('api_key','oauth_client','webhook_secret','stripe_account')
                       ),
  encrypted_secret_ref text not null,
  scopes               text[] not null default '{}'::text[],
  active               boolean not null default true,
  rotated_at           timestamptz,
  expires_at           timestamptz,
  evidence             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (provider, environment, credential_kind)
);

comment on table public.merchant_provider_credentials is
  'MERCHANT-1 provider credential metadata. encrypted_secret_ref points at the secret vault entry; plaintext secrets never live in Postgres.';
comment on column public.merchant_provider_credentials.encrypted_secret_ref is
  'Reference to environment-backed or vault-backed secret material, not the secret itself.';

create index if not exists merchant_provider_credentials_active_by_provider
  on public.merchant_provider_credentials (provider, environment, credential_kind)
  where active = true;

drop trigger if exists merchant_provider_credentials_touch_updated_at on public.merchant_provider_credentials;
create trigger merchant_provider_credentials_touch_updated_at
  before update on public.merchant_provider_credentials
  for each row execute function public.touch_updated_at();

create table if not exists public.payments_customers (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  livemode           boolean not null default false,
  email              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.payments_customers is
  'MERCHANT-1 one-to-one mapping from Lumo user to Stripe Customer.';

drop trigger if exists payments_customers_touch_updated_at on public.payments_customers;
create trigger payments_customers_touch_updated_at
  before update on public.payments_customers
  for each row execute function public.touch_updated_at();

create table if not exists public.payment_methods (
  id                 text primary key check (id ~ '^pm_[A-Za-z0-9_]+$'),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  stripe_customer_id text not null references public.payments_customers(stripe_customer_id) on delete cascade,
  brand              text not null default 'unknown',
  last4              text not null check (last4 ~ '^[0-9]{4}$'),
  exp_month          integer not null check (exp_month between 1 and 12),
  exp_year           integer not null check (exp_year between 2020 and 2100),
  is_default         boolean not null default false,
  fingerprint        text,
  livemode           boolean not null default false,
  billing_details    jsonb not null default '{}'::jsonb,
  attached_at        timestamptz not null default now(),
  detached_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, id),
  check (detached_at is null or detached_at >= attached_at)
);

comment on table public.payment_methods is
  'MERCHANT-1 Stripe PaymentMethod mirror. Stores card metadata only; never PAN or CVV.';

create index if not exists payment_methods_by_user_attached
  on public.payment_methods (user_id, attached_at desc)
  where detached_at is null;

create unique index if not exists payment_methods_one_default_per_user
  on public.payment_methods (user_id)
  where is_default = true and detached_at is null;

drop trigger if exists payment_methods_touch_updated_at on public.payment_methods;
create trigger payment_methods_touch_updated_at
  before update on public.payment_methods
  for each row execute function public.touch_updated_at();

create table if not exists public.confirmation_keys (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  device_id              text not null check (char_length(device_id) between 8 and 160),
  public_key_pem         text not null check (public_key_pem like '-----BEGIN PUBLIC KEY-----%'),
  public_key_fingerprint text not null check (public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  algorithm              text not null default 'ecdsa-p256' check (algorithm in ('ecdsa-p256')),
  state                  text not null default 'active' check (state in ('active','revoked')),
  last_used_at           timestamptz,
  revoked_at             timestamptz,
  revoke_reason          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (user_id, device_id),
  unique (public_key_fingerprint),
  check ((state = 'revoked' and revoked_at is not null) or (state = 'active' and revoked_at is null))
);

comment on table public.confirmation_keys is
  'MERCHANT-1 per-device ECDSA-P256 public keys used to verify biometric transaction confirmations.';

create index if not exists confirmation_keys_active_by_user
  on public.confirmation_keys (user_id, device_id)
  where state = 'active';

drop trigger if exists confirmation_keys_touch_updated_at on public.confirmation_keys;
create trigger confirmation_keys_touch_updated_at
  before update on public.confirmation_keys
  for each row execute function public.touch_updated_at();

create or replace function public.confirmation_keys_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    if old.id is distinct from new.id
       or old.user_id is distinct from new.user_id
       or old.device_id is distinct from new.device_id
       or old.public_key_pem is distinct from new.public_key_pem
       or old.public_key_fingerprint is distinct from new.public_key_fingerprint
       or old.algorithm is distinct from new.algorithm
       or old.created_at is distinct from new.created_at then
      raise exception 'CONFIRMATION_KEY_IDENTITY_IMMUTABLE'
        using hint = 'Register a new device key instead of mutating key identity';
    end if;

    if old.state = 'revoked' and new.state <> 'revoked' then
      raise exception 'CONFIRMATION_KEY_REVOCATION_IMMUTABLE'
        using hint = 'Revoked device confirmation keys cannot be reactivated';
    end if;

    return new;
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_confirmation_key_delete', true) <> 'true' then
      raise exception 'CONFIRMATION_KEYS_APPEND_ONLY'
        using hint = 'Confirmation keys are security evidence; revoke instead of deleting';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists confirmation_keys_state_guard on public.confirmation_keys;
create trigger confirmation_keys_state_guard
  before update or delete on public.confirmation_keys
  for each row execute function public.confirmation_keys_guard();

create table if not exists public.transactions (
  id                           uuid primary key default gen_random_uuid(),
  user_id                      uuid not null references public.profiles(id) on delete cascade,
  mission_id                   uuid references public.missions(id) on delete set null,
  mission_step_id              uuid references public.mission_steps(id) on delete set null,
  agent_id                     text not null,
  agent_version                text not null,
  provider                     text not null check (provider in (
                                 'duffel',
                                 'booking',
                                 'expedia_partner_solutions',
                                 'uber_for_business',
                                 'stripe_issuing',
                                 'stripe_payments',
                                 'mock_merchant'
                               )),
  capability_id                text,
  idempotency_key              text not null,
  status                       text not null default 'draft' check (
                                 status in (
                                   'draft',
                                   'awaiting_confirmation',
                                   'authorized',
                                   'executing',
                                   'partially_committed',
                                   'committed',
                                   'rolling_back',
                                   'rolled_back',
                                   'refund_pending',
                                   'refunded',
                                   'failed',
                                   'manual_review'
                                 )
                               ),
  currency                     text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  authorized_amount_cents      integer not null default 0 check (authorized_amount_cents >= 0),
  captured_amount_cents        integer not null default 0 check (captured_amount_cents >= 0),
  refunded_amount_cents        integer not null default 0 check (refunded_amount_cents >= 0),
  stripe_customer_id           text references public.payments_customers(stripe_customer_id) on delete set null,
  payment_method_id            text references public.payment_methods(id) on delete set null,
  payment_intent_id            text check (payment_intent_id is null or payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  stripe_charge_id             text,
  stripe_latest_event_id       text,
  confirmation_device_id       text,
  confirmation_key_id          uuid references public.confirmation_keys(id) on delete set null,
  confirmation_digest          text check (confirmation_digest is null or confirmation_digest ~ '^[a-f0-9]{64}$'),
  signed_confirmation_hash     text check (signed_confirmation_hash is null or signed_confirmation_hash ~ '^[a-f0-9]{64}$'),
  confirmation_card_id         text,
  payment_method_label         text,
  line_items                   jsonb not null default '[]'::jsonb,
  receipt_url                  text,
  refund_of_transaction_id     uuid references public.transactions(id) on delete set null,
  evidence                     jsonb not null default '{}'::jsonb,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (user_id, agent_id, idempotency_key),
  check (captured_amount_cents <= authorized_amount_cents),
  check (refunded_amount_cents <= captured_amount_cents),
  check (jsonb_typeof(line_items) = 'array')
);

comment on table public.transactions is
  'MERCHANT-1 user-facing transaction ledger. Stripe webhooks reconcile this row; provider legs live in transaction_legs.';
comment on column public.transactions.idempotency_key is
  'Platform ledger key: merchant:<mission_id>:<mission_step_id>:<capability_id>:<attempt_group>.';

create index if not exists transactions_by_user_created
  on public.transactions (user_id, created_at desc);

create index if not exists transactions_by_mission_step
  on public.transactions (mission_step_id)
  where mission_step_id is not null;

create unique index if not exists transactions_by_payment_intent
  on public.transactions (payment_intent_id)
  where payment_intent_id is not null;

create index if not exists transactions_open_by_provider
  on public.transactions (provider, updated_at desc)
  where status not in ('committed','rolled_back','refunded','failed');

drop trigger if exists transactions_touch_updated_at on public.transactions;
create trigger transactions_touch_updated_at
  before update on public.transactions
  for each row execute function public.touch_updated_at();

create or replace function public.transactions_retry_safe_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    if old.id is distinct from new.id
       or old.user_id is distinct from new.user_id
       or old.mission_id is distinct from new.mission_id
       or old.mission_step_id is distinct from new.mission_step_id
       or old.agent_id is distinct from new.agent_id
       or old.agent_version is distinct from new.agent_version
       or old.provider is distinct from new.provider
       or old.capability_id is distinct from new.capability_id
       or old.idempotency_key is distinct from new.idempotency_key
       or old.created_at is distinct from new.created_at then
      raise exception 'TRANSACTION_IDENTITY_IMMUTABLE'
        using hint = 'Retries and webhooks may reconcile status/payment fields, but transaction identity is immutable';
    end if;
    return new;
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_transaction_delete', true) <> 'true' then
      raise exception 'TRANSACTIONS_APPEND_ONLY'
        using hint = 'Merchant transactions are ledger evidence; append refund/compensation rows instead of deleting';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists transactions_retry_safe_guard on public.transactions;
create trigger transactions_retry_safe_guard
  before update or delete on public.transactions
  for each row execute function public.transactions_retry_safe_append_only();

create table if not exists public.transaction_legs (
  id                         uuid primary key default gen_random_uuid(),
  transaction_id             uuid not null references public.transactions(id) on delete cascade,
  mission_step_id            uuid references public.mission_steps(id) on delete set null,
  step_order                 integer not null check (step_order >= 0),
  provider                   text not null check (provider in (
                               'duffel',
                               'booking',
                               'expedia_partner_solutions',
                               'uber_for_business',
                               'stripe_issuing',
                               'stripe_payments',
                               'mock_merchant'
                             )),
  capability_id              text not null,
  compensation_capability_id text,
  idempotency_key            text not null,
  status                     text not null default 'pending' check (
                               status in (
                                 'pending',
                                 'awaiting_confirmation',
                                 'authorized',
                                 'in_flight',
                                 'committed',
                                 'failed',
                                 'rollback_pending',
                                 'rollback_in_flight',
                                 'rolled_back',
                                 'rollback_failed',
                                 'manual_review'
                               )
                             ),
  depends_on                 integer[] not null default '{}'::integer[],
  amount_cents               integer not null default 0 check (amount_cents >= 0),
  currency                   text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  provider_reference         text,
  provider_status            text,
  refund_window_ends_at      timestamptz,
  request_payload_hash       text check (request_payload_hash is null or request_payload_hash ~ '^[a-f0-9]{64}$'),
  response_payload_hash      text check (response_payload_hash is null or response_payload_hash ~ '^[a-f0-9]{64}$'),
  evidence                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (transaction_id, step_order),
  unique (provider, idempotency_key)
);

comment on table public.transaction_legs is
  'MERCHANT-1 provider-side transaction legs. COMPOUND-EXEC-1 will drive dependency ordering and compensation.';

create index if not exists transaction_legs_by_transaction_order
  on public.transaction_legs (transaction_id, step_order);

create index if not exists transaction_legs_by_mission_step
  on public.transaction_legs (mission_step_id)
  where mission_step_id is not null;

create index if not exists transaction_legs_open_by_provider
  on public.transaction_legs (provider, updated_at desc)
  where status not in ('committed','rolled_back','rollback_failed','failed');

drop trigger if exists transaction_legs_touch_updated_at on public.transaction_legs;
create trigger transaction_legs_touch_updated_at
  before update on public.transaction_legs
  for each row execute function public.touch_updated_at();

create or replace function public.transaction_legs_retry_safe_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    if old.id is distinct from new.id
       or old.transaction_id is distinct from new.transaction_id
       or old.mission_step_id is distinct from new.mission_step_id
       or old.step_order is distinct from new.step_order
       or old.provider is distinct from new.provider
       or old.capability_id is distinct from new.capability_id
       or old.compensation_capability_id is distinct from new.compensation_capability_id
       or old.idempotency_key is distinct from new.idempotency_key
       or old.depends_on is distinct from new.depends_on
       or old.created_at is distinct from new.created_at then
      raise exception 'TRANSACTION_LEG_IDENTITY_IMMUTABLE'
        using hint = 'Retries and webhooks may reconcile status/provider fields, but leg identity is immutable';
    end if;
    return new;
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_transaction_leg_delete', true) <> 'true' then
      raise exception 'TRANSACTION_LEGS_APPEND_ONLY'
        using hint = 'Merchant transaction legs are ledger evidence';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists transaction_legs_retry_safe_guard on public.transaction_legs;
create trigger transaction_legs_retry_safe_guard
  before update or delete on public.transaction_legs
  for each row execute function public.transaction_legs_retry_safe_append_only();

create table if not exists public.stripe_webhook_events (
  event_id          text primary key check (event_id ~ '^evt_[A-Za-z0-9_]+$'),
  event_type        text not null,
  livemode          boolean not null default false,
  payment_intent_id text,
  setup_intent_id   text,
  payload_sha256    text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  processing_status text not null default 'processed' check (
                      processing_status in ('processing','processed','ignored','failed')
                    ),
  error_message     text,
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((processing_status = 'processed' and processed_at is not null) or processing_status <> 'processed')
);

comment on table public.stripe_webhook_events is
  'MERCHANT-1 Stripe webhook idempotency ledger. Stripe retries are deduped by event_id.';

create index if not exists stripe_webhook_events_by_type_created
  on public.stripe_webhook_events (event_type, created_at desc);

drop trigger if exists stripe_webhook_events_touch_updated_at on public.stripe_webhook_events;
create trigger stripe_webhook_events_touch_updated_at
  before update on public.stripe_webhook_events
  for each row execute function public.touch_updated_at();

alter table public.merchant_provider_credentials enable row level security;
alter table public.payments_customers enable row level security;
alter table public.payment_methods enable row level security;
alter table public.confirmation_keys enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_legs enable row level security;
alter table public.stripe_webhook_events enable row level security;

revoke all on public.merchant_provider_credentials from anon, authenticated;
revoke all on public.payments_customers from anon, authenticated;
revoke all on public.payment_methods from anon, authenticated;
revoke all on public.confirmation_keys from anon, authenticated;
revoke all on public.transactions from anon, authenticated;
revoke all on public.transaction_legs from anon, authenticated;
revoke all on public.stripe_webhook_events from anon, authenticated;

grant all on public.merchant_provider_credentials to service_role;
grant all on public.payments_customers to service_role;
grant all on public.payment_methods to service_role;
grant all on public.confirmation_keys to service_role;
grant all on public.transactions to service_role;
grant all on public.transaction_legs to service_role;
grant all on public.stripe_webhook_events to service_role;

grant select on public.payments_customers to authenticated;
grant select on public.payment_methods to authenticated;
grant select on public.confirmation_keys to authenticated;
grant select on public.transactions to authenticated;
grant select on public.transaction_legs to authenticated;

drop policy if exists payments_customers_select_own on public.payments_customers;
create policy payments_customers_select_own on public.payments_customers
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists payment_methods_select_own on public.payment_methods;
create policy payment_methods_select_own on public.payment_methods
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists confirmation_keys_select_own on public.confirmation_keys;
create policy confirmation_keys_select_own on public.confirmation_keys
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists transactions_select_own on public.transactions;
create policy transactions_select_own on public.transactions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists transaction_legs_select_own on public.transaction_legs;
create policy transaction_legs_select_own on public.transaction_legs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.transactions t
      where t.id = transaction_legs.transaction_id
        and t.user_id = (select auth.uid())
    )
  );
