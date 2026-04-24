-- Migration 004 — appstore: per-user OAuth connections to agents.
--
-- This is the foundational schema for the "users connect apps, Super Agent
-- acts on their behalf" model. The Super Agent does NOT itself mint tokens
-- to downstream agents — each agent is its own OAuth provider (Model A:
-- OAuth 2.0 per agent, locked in on 2026-04-24). The Super Agent stores
-- the access/refresh tokens, encrypted at rest, and attaches the access
-- token as Authorization: Bearer <token> on every dispatch to that agent
-- for that user.
--
-- Tables:
--
--   profiles           — public-schema mirror of auth.users we can join to
--                        and foreign-key into. Just stores whatever display
--                        data the UI needs (full name, avatar_url, email).
--                        Kept minimal on purpose — the source of truth for
--                        identity is Supabase Auth.
--
--   agent_connections  — one row per (user, agent) active connection. Stores
--                        the encrypted access + refresh tokens plus metadata
--                        the dispatcher needs to know whether to auto-refresh.
--                        Tokens are AES-256-GCM encrypted by lib/crypto.ts
--                        using LUMO_ENCRYPTION_KEY — this table holds
--                        ciphertext only. A leaked database dump without the
--                        encryption key is useless; rotate the key and
--                        everyone gets logged out of every agent (acceptable).
--
--   oauth_states       — short-lived state store for the OAuth authorize flow.
--                        We could sign the state into a cookie instead but a
--                        DB row lets us (a) rate-limit by user_id, (b) attach
--                        PKCE code_verifier server-side without exposing it,
--                        (c) inspect/debug a stuck flow. Rows expire after
--                        10 minutes; a cron sweeps old rows.
--
-- RLS: off for now. Service-role key on the server reads/writes these rows;
-- no browser client path exists yet. Enable with policies before exposing
-- any client-side query path.
--
-- Safe to re-run: all CREATE statements use IF NOT EXISTS.

-- ────────────────────────────────────────────────────────────────────
-- profiles — joinable public shadow of auth.users
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  full_name    text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Populate profiles automatically when a new auth.users row is created.
-- The trigger fires on INSERT only — it doesn't fight the UI's profile-
-- edit flow that also writes full_name/avatar_url.
create or replace function public.tg_handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_handle_new_user();

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.tg_touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- agent_connections — per-user OAuth tokens for each connected agent
-- ────────────────────────────────────────────────────────────────────
--
-- One active connection per (user, agent). Revoked/expired rows are kept
-- for audit (we want to know when a user disconnected, which scopes they
-- had, and why tokens stopped working).
--
-- Tokens are stored as three bytea columns each (ciphertext, iv, auth tag)
-- because GCM authenticated encryption needs all three to decrypt safely.
-- Storing them as a single concatenated blob would work but splitting
-- them makes the encryption format explicit and lets us rotate the
-- encryption scheme later (e.g., switching to libsodium sealed boxes)
-- without data migration.
--
-- status lifecycle:
--   active     — tokens valid or refreshable; the router uses this row.
--   expired    — access token expired AND either no refresh token OR
--                refresh failed. User needs to reconnect. Set by the
--                router when it hits a 401 after a refresh attempt.
--   revoked    — user clicked Disconnect, OR agent revoked the grant.
--                We call the agent's revocation endpoint on disconnect
--                where available; regardless, the row stays in the DB
--                for audit.
--   error      — tokens are present but the last N dispatches failed
--                with a non-401 auth error. Parking state; support
--                intervention needed. Never set automatically in MVP.
create table if not exists public.agent_connections (
  id                         text primary key,
  user_id                    uuid not null references public.profiles(id) on delete cascade,
  agent_id                   text not null,

  status                     text not null check (status in (
                               'active', 'expired', 'revoked', 'error'
                             )),

  access_token_ciphertext    bytea not null,
  access_token_iv            bytea not null,
  access_token_tag           bytea not null,

  refresh_token_ciphertext   bytea,
  refresh_token_iv           bytea,
  refresh_token_tag          bytea,

  expires_at                 timestamptz,
  scopes                     jsonb not null default '[]'::jsonb,

  -- The agent's internal user identifier for this person, if returned by
  -- the token endpoint or a subsequent /me call. Useful for debugging and
  -- for the agent's own logs to correlate. Opaque to the Super Agent.
  provider_account_id        text,

  connected_at               timestamptz not null default now(),
  last_refreshed_at          timestamptz,
  last_used_at               timestamptz,
  revoked_at                 timestamptz,
  updated_at                 timestamptz not null default now()
);

-- One active connection per (user, agent). Partial unique index so a user
-- can have a history of revoked/expired connections plus one active row.
create unique index if not exists agent_connections_one_active
  on public.agent_connections (user_id, agent_id)
  where status = 'active';

create index if not exists agent_connections_by_user
  on public.agent_connections (user_id, updated_at desc);

create index if not exists agent_connections_by_agent
  on public.agent_connections (agent_id)
  where status = 'active';

drop trigger if exists agent_connections_touch_updated_at on public.agent_connections;
create trigger agent_connections_touch_updated_at
  before update on public.agent_connections
  for each row execute function public.tg_touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- oauth_states — short-lived PKCE + state store for authorize flow
-- ────────────────────────────────────────────────────────────────────
--
-- Written at /api/connections/start, read-once at /api/connections/callback,
-- deleted on consume. Rows that are never consumed (user closed tab mid-
-- flow) expire after 10 minutes — cron sweep below.
--
-- We include the desired post-connect redirect here so the callback can
-- bring the user back to wherever they clicked Connect from (marketplace
-- detail page, onboarding wizard, inline connect nudge in chat).
create table if not exists public.oauth_states (
  state             text primary key,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  agent_id          text not null,
  code_verifier     text not null,
  redirect_after    text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '10 minutes')
);

create index if not exists oauth_states_expiry_idx
  on public.oauth_states (expires_at);

-- Sweep expired rows opportunistically. Called manually for now; wire into
-- a pg_cron job in prod:
--   select cron.schedule('oauth-states-sweep', '*/15 * * * *',
--     $$delete from public.oauth_states where expires_at < now()$$);
-- Until then, /api/connections/start calls this inline when it writes a
-- new state (cheap because of the index).
create or replace function public.sweep_expired_oauth_states()
returns int language plpgsql as $$
declare
  deleted int;
begin
  delete from public.oauth_states where expires_at < now()
  returning 1 into deleted;
  return coalesce(deleted, 0);
end;
$$;
