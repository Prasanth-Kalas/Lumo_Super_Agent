-- Lumo Super Agent — run-all migrations (generated)
-- Concatenation of db/migrations/001...023 in order. Safe to re-run:
-- every CREATE uses IF NOT EXISTS and every ALTER uses ADD COLUMN IF NOT EXISTS.
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- DO NOT EDIT BY HAND. Regenerate via:  node db/build-run-all.mjs

-- ════════════════════════════════════════════════════════════════
-- db/migrations/001_trips_and_events.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 001 — trip-state persistence + append-only audit log.
--
-- Run this in the Supabase SQL editor (or via `supabase db push`) against
-- the project whose URL + service-role key you've stored in
-- SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on the Super Agent project.
--
-- Tables:
--
--   trips       — compound-booking envelope (one row per user-confirmed
--                 trip draft, including those that never got confirmed).
--   trip_legs   — per-leg execution state. Fk to trips, unique on
--                 (trip_id, "order"). Updated in place as legs move
--                 pending → in_flight → committed|failed → rolled_back.
--   events      — append-only audit log of every SSE frame the route
--                 handler emits. This is the replay source for
--                 incident postmortems and user-facing "what happened
--                 to my trip?" queries.
--
-- Everything uses `text` keys (not uuids) because the orchestrator mints
-- opaque identifiers the client needs to thread through URLs — uuid v7
-- is fine on the server but text is stable across ORM swaps.
--
-- RLS is OFF for these tables in v1 — the service-role key bypasses it
-- anyway, and no browser client reads these tables directly. Turn it on
-- before exposing any client-side query path.

-- ────────────────────────────────────────────────────────────────────
-- trips
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.trips (
  trip_id       text primary key,
  session_id    text not null,
  user_id       text not null,
  status        text not null check (status in (
                  'draft',
                  'confirmed',
                  'dispatching',
                  'committed',
                  'rolled_back',
                  'rollback_failed'
                )),
  hash          text not null,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists trips_session_idx on public.trips (session_id);
create index if not exists trips_user_idx    on public.trips (user_id);
create index if not exists trips_status_idx  on public.trips (status);

-- Enforce "one live trip per session" — a session can have many
-- historical trips, but at most one in a non-terminal state at a time.
-- Partial unique index on the rows that matter.
create unique index if not exists trips_one_live_per_session
  on public.trips (session_id)
  where status in ('draft', 'confirmed', 'dispatching');

-- ────────────────────────────────────────────────────────────────────
-- trip_legs
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.trip_legs (
  trip_id       text not null references public.trips(trip_id) on delete cascade,
  "order"       smallint not null,
  agent_id      text not null,
  tool_name     text not null,
  depends_on    smallint[] not null default '{}',
  status        text not null check (status in (
                  'pending',
                  'in_flight',
                  'committed',
                  'failed',
                  'rolled_back',
                  'rollback_failed'
                )),
  booking_id    text,
  error_detail  jsonb,
  updated_at    timestamptz not null default now(),
  primary key (trip_id, "order")
);

create index if not exists trip_legs_status_idx on public.trip_legs (status);

-- ────────────────────────────────────────────────────────────────────
-- events — append-only audit log
-- ────────────────────────────────────────────────────────────────────
-- Every SSE frame the route handler sends also goes here. This is the
-- contract that underpins two P0 capabilities:
--   (a) enterprise audit log — what the user saw, when, and why,
--   (b) replay — given a session_id + turn_id, reconstruct the exact
--       sequence of frames the shell consumed, which in turn reproduces
--       the tool calls, selections, and confirmation card state.
--
-- Never update or delete rows here. This table is insert-only by
-- convention; tighten with a policy if you enable RLS.
create table if not exists public.events (
  event_id     bigserial primary key,
  session_id   text not null,
  turn_id      text,
  trip_id      text,
  frame_type   text not null check (frame_type in (
                  'text',
                  'tool',
                  'selection',
                  'summary',
                  'leg_status',
                  'error',
                  'done',
                  'request',           -- inbound user message, recorded by route handler
                  'internal'           -- orchestrator-side non-SSE events (tool retries, saga decisions)
                )),
  frame_value  jsonb not null,
  ts           timestamptz not null default now()
);

create index if not exists events_session_ts_idx on public.events (session_id, ts);
create index if not exists events_trip_ts_idx    on public.events (trip_id, ts) where trip_id is not null;
create index if not exists events_turn_idx       on public.events (turn_id)     where turn_id is not null;
create index if not exists events_type_ts_idx    on public.events (frame_type, ts);

-- ────────────────────────────────────────────────────────────────────
-- Housekeeping trigger — keep trips.updated_at fresh automatically
-- ────────────────────────────────────────────────────────────────────
create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trips_touch_updated_at on public.trips;
create trigger trips_touch_updated_at
  before update on public.trips
  for each row execute function public.tg_touch_updated_at();

drop trigger if exists trip_legs_touch_updated_at on public.trip_legs;
create trigger trip_legs_touch_updated_at
  before update on public.trip_legs
  for each row execute function public.tg_touch_updated_at();

-- ════════════════════════════════════════════════════════════════
-- db/migrations/002_cancel_requested.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 002: user-initiated cancel flag on trips.
--
-- Rationale: the /api/trip/[trip_id]/cancel endpoint needs to signal
-- an in-flight dispatch loop (running in a different request, possibly
-- on a different Vercel function instance) to stop dispatching new
-- legs and fall through to Saga rollback. An in-memory flag won't
-- survive horizontal scale; an events-table sentinel would require a
-- poll that reads N rows per leg. A single column on the trip row is
-- cheap and checked once per leg boundary.
--
-- Non-null default: NULL == no cancel pending; timestamp == requested
-- at this time. We keep the timestamp (not a bool) so replay can show
-- when the user pressed the button relative to leg progress.
--
-- Safe to re-run: IF NOT EXISTS guards prevent double-add.

alter table if exists trips
  add column if not exists cancel_requested_at timestamptz;

-- Index is narrow: we only query "has cancel been requested for this
-- trip?" — a point lookup by trip_id. trips PK already covers that.
-- The touch trigger already bumps updated_at on any column change so
-- no additional trigger needed.

-- ════════════════════════════════════════════════════════════════
-- db/migrations/003_escalations.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 003: escalation queue for rollback_failed trips.
--
-- Rationale: when Saga's compensation tool itself errors (the refund
-- API 500s, a cancel tool is missing, a leg's booking_id is null so
-- we can't address the vendor side), the leg lands in
-- `rollback_failed` and the trip terminates in `rollback_failed`.
-- Before this migration, those trips sat silently in the database
-- and nobody knew to do anything about them. That's the worst
-- failure mode: the user has been charged, the booking still
-- exists vendor-side, and nobody's looking.
--
-- `escalations` is the queue. One row per leg that needs human
-- follow-up. Ops (support, finance) can query `status = 'open'` to
-- get the backlog.
--
-- Design:
--   - escalation_id: stable opaque identifier for linking in comms
--   - trip_id + leg_order: FK shape (no actual FK — we want
--     escalations to survive trip-row retention policies). Use
--     readTripEvents(trip_id) for full timeline when triaging.
--   - reason: enum-ish string — what exactly went wrong. Keeps the
--     query surface small ("all payment_failed escalations from
--     the last 24h" is one predicate).
--   - detail: jsonb for the full error payload and whatever extra
--     context (agent_id, booking_id, refund ref id, etc) the
--     escalator had at hand.
--   - status: open → investigating → resolved. `status = 'open'` +
--     oldest-first (partial index below) is the ops hot path.
--   - resolution_notes: free text once an op closes it out.
--
-- Indexes keep the open-queue cheap and trip-lookup O(1).

create table if not exists escalations (
  escalation_id text primary key,
  trip_id text not null,
  session_id text,
  user_id text,
  leg_order int,
  reason text not null,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open', 'investigating', 'resolved')),
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Partial index for the ops hot path: "show me open escalations,
-- oldest first". Partial so it's small even if we accumulate
-- millions of resolved rows over time.
create index if not exists escalations_open_oldest_idx
  on escalations (created_at asc)
  where status = 'open';

-- Trip timeline lookup.
create index if not exists escalations_by_trip_idx
  on escalations (trip_id);

-- User-facing "what's pending for me" lookup.
create index if not exists escalations_by_user_open_idx
  on escalations (user_id, created_at desc)
  where status = 'open';

-- Auto-touch updated_at on any column change, mirroring the trips
-- table behavior from migration 001.
drop trigger if exists trg_touch_escalations_updated_at on escalations;
create trigger trg_touch_escalations_updated_at
  before update on escalations
  for each row
  execute function tg_touch_updated_at();

-- ════════════════════════════════════════════════════════════════
-- db/migrations/004_appstore.sql
-- ════════════════════════════════════════════════════════════════

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

-- ════════════════════════════════════════════════════════════════
-- db/migrations/005_memory.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 005 — J1 Memory + J4 Ambient Context.
--
-- This is the foundation of the "Lumo-like" loop: the Super Agent stops
-- forgetting the user between sessions. Three tables, each with a narrow
-- responsibility:
--
--   user_profile            — structured, user-editable preferences and
--                             identity. One row per user. The source of
--                             truth for home/work addresses, dietary flags,
--                             travel preferences, etc.
--
--   user_facts              — append-only free-text memories extracted by
--                             Claude during conversation. Semantically
--                             searchable via pgvector embeddings. Soft-
--                             delete (deleted_at) so a user's "forget that"
--                             is recoverable for 30 days.
--
--   user_behavior_patterns  — aggregations built offline from the events
--                             table ("user orders pizza on Friday
--                             evenings", "user travels NYC→LA monthly").
--                             Rebuilt by a nightly job (not yet wired).
--
-- Privacy posture: every row here is per-user, no cross-user joins, no
-- PII in indexes. Soft-delete preserves audit trail but the user's
-- /memory UI filters deleted rows out. A full hard-delete ("wipe
-- everything Lumo knows about me") is a one-line DELETE that cascades
-- via profiles(id) ON DELETE CASCADE.
--
-- pgvector: we use text-embedding-3-small (1536 dims) via OpenAI. If the
-- OPENAI_API_KEY isn't set the memory layer degrades to recency-only
-- retrieval — the column stays nullable on purpose to support that path.

-- ────────────────────────────────────────────────────────────────────
-- Extensions
-- ────────────────────────────────────────────────────────────────────
create extension if not exists vector;

-- ────────────────────────────────────────────────────────────────────
-- user_profile — structured, editable
-- ────────────────────────────────────────────────────────────────────
-- Kept narrow in v1. Adding a new field is cheap; removing one is
-- expensive because of UI code paths — so we hold the line on "structured
-- fields are for things with obvious shape and obvious privacy story".
-- Anything fuzzier goes in user_facts.
--
-- Addresses are jsonb rather than exploded columns so an agent that
-- needs delivery coords gets the whole object in one read, and schema
-- evolution (adding apartment_number, floor, gate_code) doesn't need a
-- migration.
create table if not exists public.user_profile (
  id                           uuid primary key references public.profiles(id) on delete cascade,

  -- Identity / locale
  display_name                 text,
  timezone                     text,
  preferred_language           text,

  -- Canonical addresses. Shape:
  --   { "label": "Home", "line1": "...", "city": "...", "region": "...",
  --     "country": "...", "postal_code": "...",
  --     "coords": { "lat": 37.77, "lng": -122.41 } }
  home_address                 jsonb,
  work_address                 jsonb,

  -- Dietary + health. text[] for set semantics and easy contains-check.
  dietary_flags                text[] not null default '{}',
  allergies                    text[] not null default '{}',
  preferred_cuisines           text[] not null default '{}',

  -- Travel
  preferred_airline_class      text,   -- "economy" | "premium_economy" | "business" | "first"
  preferred_airline_seat       text,   -- "aisle" | "window" | "middle" | "any"
  frequent_flyer_numbers       jsonb,  -- { "UA": "...", "AA": "...", ... }
  preferred_hotel_chains       text[] not null default '{}',

  -- Budget — coarse tier; agents can use it as a soft default when user
  -- hasn't specified a price ceiling on a turn.
  budget_tier                  text,   -- "budget" | "standard" | "premium"

  -- Payment hint — we never store raw card numbers here. This is a
  -- human-readable label like "Chase Sapphire •• 4242" or an agent-scoped
  -- alias. The actual PCI-compliant token lives with Stripe/Food Agent.
  preferred_payment_hint       text,

  -- Opaque scratchpad for fields we don't have explicit columns for yet.
  -- Gives Claude room to stash structured extras without schema churn.
  extra                        jsonb not null default '{}'::jsonb,

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

drop trigger if exists user_profile_touch_updated_at on public.user_profile;
create trigger user_profile_touch_updated_at
  before update on public.user_profile
  for each row execute function public.tg_touch_updated_at();

-- Auto-provision an empty user_profile row when a new profiles row lands
-- (which happens via auth.users trigger from migration 004). Saves every
-- read path from having to handle "row might not exist yet" — they can
-- just select and trust.
create or replace function public.tg_handle_new_profile()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_profile (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created on public.profiles;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.tg_handle_new_profile();

-- Backfill for existing rows (safe to re-run).
insert into public.user_profile (id)
  select p.id from public.profiles p
  left join public.user_profile up on up.id = p.id
  where up.id is null;

-- ────────────────────────────────────────────────────────────────────
-- user_facts — free-text memories with embeddings
-- ────────────────────────────────────────────────────────────────────
-- Append-mostly. Claude emits memory_save tool calls during conversation;
-- each one becomes a row here. Retrieval is:
--
--   select ... where user_id = $1 and deleted_at is null
--   order by
--     (embedding <=> $query_embedding) * 0.8 +        -- semantic
--     (1 - exp(-extract(epoch from (now() - last_confirmed_at)) / 604800.0)) * 0.2
--     -- recency: 7-day half-life
--   limit 8
--
-- Facts are categorized so the UI can group them. `supersedes_id` lets a
-- new fact explicitly replace an older one (e.g., the user moved houses,
-- the new home_address fact replaces the old one — but we keep the
-- history).
--
-- Soft-delete via deleted_at rather than DELETE so "forget that" is
-- reversible for a grace period and so audit is preserved.
create table if not exists public.user_facts (
  id                     text primary key,
  user_id                uuid not null references public.profiles(id) on delete cascade,

  fact                   text not null check (char_length(fact) between 3 and 2000),
  category               text not null check (category in (
                           'preference',    -- likes/dislikes
                           'identity',      -- names, roles, relationships
                           'habit',         -- recurring patterns user self-describes
                           'location',      -- home/work/favorites
                           'constraint',    -- dietary, allergy, accessibility
                           'context',       -- short-lived: "traveling this week"
                           'milestone',     -- "birthday is May 12", "anniversary is 8/3"
                           'other'
                         )),

  -- Provenance so the UI can say "Lumo learned this from a conversation"
  -- vs. "You told Lumo directly" vs. "Inferred from your orders".
  source                 text not null check (source in (
                           'explicit',       -- user literally said it
                           'inferred',       -- Claude concluded it from context
                           'behavioral'      -- derived from events/history
                         )) default 'explicit',

  confidence             real not null default 1.0 check (confidence between 0 and 1),

  -- 1536-dim vector for OpenAI text-embedding-3-small. Nullable: when
  -- OPENAI_API_KEY isn't configured, we still store the fact but skip
  -- the embedding; retrieval falls back to recency + keyword.
  embedding              vector(1536),

  supersedes_id          text references public.user_facts(id) on delete set null,

  first_seen_at          timestamptz not null default now(),
  last_confirmed_at      timestamptz not null default now(),
  deleted_at             timestamptz,
  updated_at             timestamptz not null default now()
);

drop trigger if exists user_facts_touch_updated_at on public.user_facts;
create trigger user_facts_touch_updated_at
  before update on public.user_facts
  for each row execute function public.tg_touch_updated_at();

-- List-facts-for-user hot path. Partial on deleted_at is null so the
-- index stays small as soft-deletes accumulate.
create index if not exists user_facts_live_by_user
  on public.user_facts (user_id, last_confirmed_at desc)
  where deleted_at is null;

-- Vector ANN index. IVFFlat is good enough for sub-100k rows per user
-- (we're nowhere near that). cosine distance matches the retrieval
-- scoring above.
create index if not exists user_facts_embedding_cosine
  on public.user_facts using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Category filter for the /memory UI grouping.
create index if not exists user_facts_by_user_category
  on public.user_facts (user_id, category)
  where deleted_at is null;

-- ────────────────────────────────────────────────────────────────────
-- user_behavior_patterns — aggregated signals from events
-- ────────────────────────────────────────────────────────────────────
-- Not populated by this migration. A nightly job (coming in J3) will
-- read events + trips, detect recurring patterns, and upsert rows here.
-- Example rows:
--   { pattern_kind: 'day_of_week',     description: 'Orders food on Fri evenings', evidence_count: 11 }
--   { pattern_kind: 'frequent_route',  description: 'NYC ↔ LAX monthly',           evidence_count: 8 }
--   { pattern_kind: 'cuisine',         description: 'Prefers Thai + Japanese',     evidence_count: 17 }
--
-- The orchestrator reads high-confidence patterns (confidence >= 0.7)
-- and folds them into the system prompt alongside user_facts.
create table if not exists public.user_behavior_patterns (
  id                  text primary key,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  pattern_kind        text not null check (pattern_kind in (
                        'day_of_week',
                        'time_of_day',
                        'frequent_route',
                        'frequent_destination',
                        'recurring_order',
                        'cuisine',
                        'budget_range',
                        'companion'
                      )),
  description         text not null,
  evidence_count      int not null default 0 check (evidence_count >= 0),
  confidence          real not null default 0 check (confidence between 0 and 1),
  first_observed_at   timestamptz not null default now(),
  last_observed_at    timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists user_behavior_patterns_touch_updated_at on public.user_behavior_patterns;
create trigger user_behavior_patterns_touch_updated_at
  before update on public.user_behavior_patterns
  for each row execute function public.tg_touch_updated_at();

create index if not exists user_behavior_patterns_by_user
  on public.user_behavior_patterns (user_id, confidence desc);

-- ────────────────────────────────────────────────────────────────────
-- Hard-delete helper — "forget everything Lumo knows about me"
-- ────────────────────────────────────────────────────────────────────
-- Callable from a /memory settings action. Keeps the profiles row (so
-- auth still works) but nukes learned context. Agent_connections and
-- trip history are NOT touched here — those have their own controls
-- (disconnect, trip cancel).
create or replace function public.forget_everything(target_user uuid)
returns void language plpgsql security definer as $$
begin
  -- Hard-delete facts (not soft) — this is the explicit user command.
  delete from public.user_facts where user_id = target_user;
  delete from public.user_behavior_patterns where user_id = target_user;
  -- Reset profile to empty shell but keep the row (FK target).
  update public.user_profile set
    display_name = null, timezone = null, preferred_language = null,
    home_address = null, work_address = null,
    dietary_flags = '{}', allergies = '{}', preferred_cuisines = '{}',
    preferred_airline_class = null, preferred_airline_seat = null,
    frequent_flyer_numbers = null, preferred_hotel_chains = '{}',
    budget_tier = null, preferred_payment_hint = null,
    extra = '{}'::jsonb
  where id = target_user;
end;
$$;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/006_notifications_intents.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 006 — J2 Proactive Engine + J3 Standing Intents.
--
-- Two tables that together make Lumo stop being purely reactive:
--
--   notifications     — the outbox. Every proactive alert the proactive-scan
--                       cron produces lands here, keyed by a stable dedup
--                       key so re-scans don't duplicate. Clients poll
--                       /api/notifications for unread items; a NotificationBell
--                       in the header renders the unread count. Web push
--                       (VAPID) is NOT wired yet — that's its own phase.
--
--   standing_intents  — user-authored routines. "Every Friday 6pm, if weather
--                       > 65°F, book a bike ride." Created via Claude meta-
--                       tools (intent_create/update/delete) from chat, or
--                       directly from the /intents UI. The evaluator cron
--                       advances next_fire_at and, when a trigger fires,
--                       drops a notification the user confirms before any
--                       action is dispatched. Auto-dispatch is deferred to
--                       J6 autonomy calibration so we don't ship a footgun.
--
-- RLS: off; service-role bypasses anyway. Client endpoints call
-- requireServerUser() and scope every query by user_id.
--
-- Safe to re-run (all CREATEs are IF NOT EXISTS, all ALTERs are idempotent).

-- ────────────────────────────────────────────────────────────────────
-- notifications — proactive alert outbox
-- ────────────────────────────────────────────────────────────────────
-- Columns:
--   kind         enum-ish string — drives icon/color in the UI ("trip_stuck",
--                "token_expiring", "trip_rolled_back", "intent_due", ...)
--   title/body   rendered as-is in the bell dropdown. Keep both short.
--   payload      jsonb with actionable context — trip_id, agent_id, etc.
--                The client uses this to deep-link (e.g. clicking a
--                "trip stuck" notification jumps to /trips/<trip_id>).
--   dedup_key    stable hash the proactive scanner computes per (rule, entity).
--                The partial unique index below enforces at-most-one live
--                notification per (user, dedup_key). When expires_at passes
--                or the user reads it, the constraint relaxes and the same
--                rule can fire fresh.
--   expires_at   notifications auto-soft-expire (we don't delete, we hide).
--                Rule-dependent: "trip stuck" expires when the trip terminates;
--                "token expiring" expires when the token refreshes.
--   read_at      null == unread; timestamp == when the user saw/dismissed it.
create table if not exists public.notifications (
  id             text primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,

  kind           text not null check (char_length(kind) between 2 and 40),
  title          text not null check (char_length(title) between 1 and 120),
  body           text check (body is null or char_length(body) between 1 and 800),
  payload        jsonb not null default '{}'::jsonb,

  dedup_key      text not null check (char_length(dedup_key) between 4 and 120),

  read_at        timestamptz,
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists notifications_touch_updated_at on public.notifications;
create trigger notifications_touch_updated_at
  before update on public.notifications
  for each row execute function public.tg_touch_updated_at();

-- At-most-one LIVE notification per (user, dedup_key). "Live" for the
-- uniqueness constraint means "unread" — we can't include
-- `expires_at > now()` in the partial predicate because Postgres
-- requires all functions in an index predicate to be IMMUTABLE, and
-- now() is STABLE. Queries that care about expiry filter
-- expires_at at query time (cheap; the dedup window is minutes,
-- not days, so few rows ever sit in the index while expired).
create unique index if not exists notifications_one_live_per_dedup
  on public.notifications (user_id, dedup_key)
  where read_at is null;

-- Unread-list hot path — the header bell's primary query.
create index if not exists notifications_unread_by_user
  on public.notifications (user_id, created_at desc)
  where read_at is null;

-- Full-history by-user (for the "all notifications" view, if we add one).
create index if not exists notifications_by_user_created
  on public.notifications (user_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────
-- standing_intents — user-authored routines
-- ────────────────────────────────────────────────────────────────────
-- Columns:
--   description     natural-language sentence, user- or Claude-authored.
--                   Example: "Every Friday at 6pm, if weather is nice,
--                   reserve a bike ride from home."
--   schedule_cron   5-field cron (minute hour dom month dow). The evaluator
--                   parses this to compute next_fire_at. "0 18 * * 5"
--                   for the example above.
--   timezone        IANA zone the cron is interpreted in. "America/Los_Angeles".
--                   Important: without this, "every Friday 6pm" drifts as the
--                   user travels or DST shifts.
--   guardrails      jsonb with conditional constraints the evaluator checks
--                   before firing. Examples:
--                     { "require_confirm": true }
--                     { "max_spend_cents": 5000 }
--                     { "weather_min_temp_f": 65 }
--                   Shape is open-ended so we can grow predicates without
--                   migrating. The evaluator matches on known keys and
--                   ignores unknown ones (fail-safe).
--   action_plan     jsonb describing WHAT to do when the trigger fires.
--                   Shape: { "tool_sequence": [ {"tool": "food_search_restaurants",
--                   "args": {...}}, ... ] }. For MVP we treat this as
--                   opaque and never auto-dispatch — the evaluator creates
--                   a notification ("your intent is due, tap to run").
--                   Real auto-dispatch is J6 work.
--   enabled         bool — pause without delete.
--   last_fired_at   when we last created a notification for this intent.
--   next_fire_at    computed by the evaluator. Sweeps for "due" query on
--                   next_fire_at <= now(); after firing, recomputes the
--                   next cron tick and updates.
create table if not exists public.standing_intents (
  id              text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,

  description     text not null check (char_length(description) between 6 and 500),
  schedule_cron   text not null check (char_length(schedule_cron) between 9 and 64),
  timezone        text not null default 'UTC',

  guardrails      jsonb not null default '{}'::jsonb,
  action_plan     jsonb not null default '{}'::jsonb,

  enabled         boolean not null default true,

  last_fired_at   timestamptz,
  next_fire_at    timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists standing_intents_touch_updated_at on public.standing_intents;
create trigger standing_intents_touch_updated_at
  before update on public.standing_intents
  for each row execute function public.tg_touch_updated_at();

-- Evaluator hot path — "find intents due to fire now". Partial on
-- enabled + not-null next_fire_at keeps it tiny even as dormant intents
-- accumulate.
create index if not exists standing_intents_due
  on public.standing_intents (next_fire_at asc)
  where enabled = true and next_fire_at is not null;

create index if not exists standing_intents_by_user
  on public.standing_intents (user_id, created_at desc);

-- ════════════════════════════════════════════════════════════════
-- db/migrations/007_autonomy.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 007 — J6 Autonomy Calibration.
--
-- This is the "how much can Lumo do without asking?" layer. Until now
-- every action required a user turn (or a user-confirmed intent notification).
-- J6 lets the user grant Lumo tiered autonomy PER TOOL CLASS — so a
-- routine like "every Friday 6pm book a bike ride" can actually fire
-- the booking without a confirmation tap, provided:
--
--   a) The user set bike_ride (or ride-share) tier = "auto", and
--   b) The day's autonomous spend is under their daily cap, and
--   c) The kill-switch hasn't been flipped.
--
-- Missing any condition → evaluator falls back to the current "drop
-- a notification" path. That way the gates are strictly additive: a
-- user who never visits /autonomy stays in the safe default.
--
-- Two tables:
--
--   user_autonomy          — per-user tier overrides + daily cap +
--                            kill-switch. One row per user with
--                            JSONB map of tool_kind → tier.
--
--   autonomous_actions     — append-only audit of everything Lumo
--                            auto-did without asking. Every row links
--                            back to the triggering intent and the
--                            tool_call's outcome. Powers the "what did
--                            Lumo do today" view and the "undo last
--                            action" button.
--
-- Tool "kinds" (not individual tool names) because the tool surface
-- grows fast — user shouldn't have to re-authorize every new Food
-- Agent tool. We bucket by intent: "food_order", "flight_book",
-- "hotel_book", "restaurant_reserve", "ride_book", etc. A tool's
-- kind is derived from its manifest category + a small mapping table
-- in lib/autonomy.ts.

-- ────────────────────────────────────────────────────────────────────
-- user_autonomy — one row per user
-- ────────────────────────────────────────────────────────────────────
-- tiers jsonb map. Each value is a tier string:
--   "always_ask"           — default. Never auto-run; always notify user to confirm.
--   "ask_if_over:<cents>"  — run auto if estimated cost < cents; else notify.
--   "auto"                 — always auto-run (still subject to daily_cap_cents).
--
-- Example:
--   {
--     "food_order":       "ask_if_over:3000",
--     "ride_book":        "auto",
--     "flight_book":      "always_ask",
--     "hotel_book":       "always_ask"
--   }
--
-- daily_cap_cents — hard cap on autonomous spend per UTC day. Exceeded
-- dispatches bounce to the notification path. Default 5000 ($50).
-- kill_switch_until — if set AND in future, ALL autonomy is paused.
-- Set by a single button on /autonomy (+24h) for panic-stop.
create table if not exists public.user_autonomy (
  user_id              uuid primary key references public.profiles(id) on delete cascade,
  tiers                jsonb not null default '{}'::jsonb,
  daily_cap_cents      integer not null default 5000 check (daily_cap_cents >= 0),
  kill_switch_until    timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

drop trigger if exists user_autonomy_touch_updated_at on public.user_autonomy;
create trigger user_autonomy_touch_updated_at
  before update on public.user_autonomy
  for each row execute function public.tg_touch_updated_at();

-- Auto-provision a row when a profile is created. Matches migrations
-- 004+005 pattern so every read path can trust "row exists."
create or replace function public.tg_handle_new_profile_autonomy()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_autonomy (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created_autonomy on public.profiles;
create trigger on_profile_created_autonomy
  after insert on public.profiles
  for each row execute function public.tg_handle_new_profile_autonomy();

-- Backfill for existing profiles.
insert into public.user_autonomy (user_id)
  select p.id from public.profiles p
  left join public.user_autonomy ua on ua.user_id = p.id
  where ua.user_id is null;

-- ────────────────────────────────────────────────────────────────────
-- autonomous_actions — audit of auto-dispatched tool calls
-- ────────────────────────────────────────────────────────────────────
-- One row per tool dispatch the autonomy gate let through without a
-- user confirmation. intent_id is the originating standing_intent;
-- tool_kind is the bucket that was authorized; tool_name is the
-- actual tool the router dispatched; amount_cents is the best estimate
-- we had at gate time (from the action_plan or the pricing step);
-- outcome is "dispatched" at write time, updated to "committed" /
-- "rolled_back" / "failed" when we know.
--
-- Why separate from the events table: events is the raw SSE-frame log
-- (one per frame), which is a firehose. autonomous_actions is a
-- narrow, user-facing "here's what I did for you today" view. It
-- powers one dashboard row, not a replay.
create table if not exists public.autonomous_actions (
  id              text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,

  intent_id       text references public.standing_intents(id) on delete set null,
  tool_kind       text not null,
  tool_name       text not null,
  agent_id        text,

  amount_cents    integer not null default 0 check (amount_cents >= 0),
  currency        text,

  -- Lifecycle. We mark 'dispatched' immediately, then advance as the
  -- router / Saga report back. Kept narrow so the query surface is
  -- small and the index stays tiny.
  outcome         text not null default 'dispatched' check (outcome in (
                    'dispatched', 'committed', 'rolled_back', 'failed'
                  )),
  error_detail    jsonb,
  request_ref     text,   -- booking_id / order_id once we have one
  summary_hash    text,   -- hash of the pricing summary that gated this

  -- For fast "today's spend per user" checks. Computed at write time
  -- from the server's UTC date so the query is a simple equality scan.
  fired_at        timestamptz not null default now(),
  fired_on_utc    date not null default (now() at time zone 'UTC')::date,
  updated_at      timestamptz not null default now()
);

drop trigger if exists autonomous_actions_touch_updated_at on public.autonomous_actions;
create trigger autonomous_actions_touch_updated_at
  before update on public.autonomous_actions
  for each row execute function public.tg_touch_updated_at();

-- Daily-spend hot path: "sum amount_cents for this user + today".
create index if not exists autonomous_actions_today_by_user
  on public.autonomous_actions (user_id, fired_on_utc);

-- Recent-history view for /autonomy.
create index if not exists autonomous_actions_recent_by_user
  on public.autonomous_actions (user_id, fired_at desc);

-- Intent drill-in: "everything this intent has fired."
create index if not exists autonomous_actions_by_intent
  on public.autonomous_actions (intent_id)
  where intent_id is not null;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/008_ops_observability.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 008 — Observability.
--
-- A single table: ops_cron_runs. Every cron endpoint writes one row at
-- the end of each tick. The /ops dashboard reads this plus the
-- existing autonomous_actions + notifications tables to surface:
--
--   - Last-run-per-cron with lag from scheduled tick (red/amber/green)
--   - Autonomy deny histogram by reason (last 7d)
--   - Pattern-detector yield per night
--   - Notification delivery counts
--
-- No new per-user rows — everything aggregates over existing tables.
-- No PII in ops_cron_runs.counts/errors — rule-specific integer
-- summaries only; raw event payloads stay in public.events.
--
-- RLS: off. Service-role only; the /api/ops/summary endpoint gates on
-- the LUMO_ADMIN_EMAILS allowlist before reading.

create table if not exists public.ops_cron_runs (
  id              text primary key,
  endpoint        text not null check (char_length(endpoint) between 3 and 80),
  started_at      timestamptz not null,
  finished_at     timestamptz not null,
  latency_ms      integer not null check (latency_ms >= 0),
  ok              boolean not null,
  counts          jsonb not null default '{}'::jsonb,
  errors          jsonb not null default '[]'::jsonb
);

-- Hot path: "last N runs of endpoint X" for the dashboard cards.
create index if not exists ops_cron_runs_by_endpoint_recent
  on public.ops_cron_runs (endpoint, finished_at desc);

-- Failure hot path: "anything that failed in the last 24h" for the
-- alerting banner.
create index if not exists ops_cron_runs_failures_recent
  on public.ops_cron_runs (finished_at desc)
  where ok = false;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/009_mcp_connections.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 009 — per-user MCP server connections.
--
-- Phase 1 of external-agents stores bearer tokens in the same sealed
-- column shape as agent_connections (migration 004). Most useful MCP
-- servers today are either
-- public (no auth) or accept a long-lived bearer token the user
-- generated themselves (Google Cloud API key, Slack xoxb, etc.).
--
-- Phase 2 will add an OAuth path for MCP servers that implement the
-- spec's 2.1 flow. At that point this table grows refresh_token and
-- expires_at, mirroring the fields already present on
-- user_agent_connections. For now, keep it small.
--
-- Security:
--   - access_token is sealed in Node with AES-256-GCM via lib/crypto.ts.
--     The DB stores ciphertext, IV, and auth tag only.
--   - RLS: users can only read their own rows. Same pattern the
--     rest of the per-user tables use.

create table if not exists user_mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Slug matches config/mcp-servers.json :: server_id. Not a FK
  -- because the catalog is file-based, not a DB table.
  server_id text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  access_token_ciphertext bytea not null,
  access_token_iv bytea not null,
  access_token_tag bytea not null,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, server_id)
);

-- Retrofit early environments that created this table with a plaintext
-- access_token column. Existing plaintext tokens cannot be safely sealed
-- from SQL because AES-GCM sealing lives in Node, so revoke those rows
-- and require users to reconnect.
alter table user_mcp_connections
  add column if not exists access_token_ciphertext bytea;

alter table user_mcp_connections
  add column if not exists access_token_iv bytea;

alter table user_mcp_connections
  add column if not exists access_token_tag bytea;

update user_mcp_connections
set status = 'revoked'
where status = 'active'
  and (
    access_token_ciphertext is null
    or access_token_iv is null
    or access_token_tag is null
  );

alter table user_mcp_connections
  drop column if exists access_token;

create index if not exists user_mcp_connections_user_active_idx
  on user_mcp_connections (user_id)
  where status = 'active';

alter table user_mcp_connections enable row level security;

-- Users can read their own connections (needed by the /memory page
-- and the client-side "already connected?" checks).
drop policy if exists user_mcp_connections_self_read on user_mcp_connections;
create policy user_mcp_connections_self_read
  on user_mcp_connections
  for select
  using (auth.uid() = user_id);

-- Users can insert a connection for themselves. Server-side routes
-- that run with the service-role key bypass this anyway; the policy
-- is belt-and-suspenders for any future anon-key client paths.
drop policy if exists user_mcp_connections_self_insert on user_mcp_connections;
create policy user_mcp_connections_self_insert
  on user_mcp_connections
  for insert
  with check (auth.uid() = user_id);

-- Users can update their own (mark revoked, rotate token).
drop policy if exists user_mcp_connections_self_update on user_mcp_connections;
create policy user_mcp_connections_self_update
  on user_mcp_connections
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Users can delete their own (cascades to revoke everywhere).
drop policy if exists user_mcp_connections_self_delete on user_mcp_connections;
create policy user_mcp_connections_self_delete
  on user_mcp_connections
  for delete
  using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════
-- db/migrations/010_partner_agents.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 010 — partner-submitted agents.
--
-- Publishers (vetted partners) submit their manifest URL through the
-- /publisher portal. An admin reviews it via /admin/review-queue and
-- either approves, rejects, or requests changes. Approved rows are
-- folded into the agent registry at startup alongside the static
-- config/agents.json — the registry loader treats both sources the
-- same.
--
-- Status machine:
--
--   pending              → submitted and certification passed; waiting
--                          for an admin to approve.
--   certification_failed → automated checks found blocking issues.
--                          Publisher can re-submit after fixing.
--   approved             → an admin has cleared the submission. Registry
--                          loads tools from this agent.
--   rejected             → human rejection. Reviewer note explains why.
--   revoked              → previously approved, pulled post-hoc.
--
-- Who can see what:
--   - The publisher (by email) sees their own submissions + status.
--   - Admins (identified by LUMO_ADMIN_EMAILS env) see everything.
--   - RLS enforces the publisher-side read. Admin reads bypass via
--     the service role key used by server routes.

create table if not exists partner_agents (
  id uuid primary key default gen_random_uuid(),

  publisher_email text not null,
  manifest_url text not null,
  -- Parsed AgentManifest at submit time, so we can render the
  -- submission detail page without re-fetching. Refreshed on every
  -- approve.
  parsed_manifest jsonb,
  certification_status text default 'failed'
    check (certification_status in ('passed', 'needs_review', 'failed')),
  certification_report jsonb,
  certified_at timestamptz,

  status text not null default 'pending'
    check (status in (
      'pending',
      'certification_failed',
      'approved',
      'rejected',
      'revoked'
    )),

  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  reviewer_note text,

  -- Attribution. Claude tool calls to this agent can be logged with
  -- this id so usage reports per publisher are trivial later.
  publisher_key text unique default encode(gen_random_bytes(24), 'hex'),

  unique (publisher_email, manifest_url)
);

-- Keep this migration safe for early Supabase projects where
-- partner_agents may already exist from a previous app-store pass.
alter table partner_agents
  add column if not exists certification_status text default 'failed';

alter table partner_agents
  add column if not exists certification_report jsonb;

alter table partner_agents
  add column if not exists certified_at timestamptz;

update partner_agents
set certification_status = coalesce(certification_status, 'failed');

alter table partner_agents
  drop constraint if exists partner_agents_certification_status_check;

alter table partner_agents
  add constraint partner_agents_certification_status_check
  check (certification_status in ('passed', 'needs_review', 'failed'));

alter table partner_agents
  drop constraint if exists partner_agents_status_check;

alter table partner_agents
  add constraint partner_agents_status_check
  check (status in (
    'pending',
    'certification_failed',
    'approved',
    'rejected',
    'revoked'
  ));

create index if not exists partner_agents_status_idx
  on partner_agents (status)
  where status in ('pending', 'approved');

create index if not exists partner_agents_publisher_idx
  on partner_agents (publisher_email);

alter table partner_agents enable row level security;

-- Publisher can read their own submissions via the normal user
-- session (policy keys on the email stored in auth.users).
drop policy if exists partner_agents_publisher_read on partner_agents;
create policy partner_agents_publisher_read
  on partner_agents
  for select
  using (
    exists (
      select 1 from auth.users u
      where u.id = auth.uid() and u.email = partner_agents.publisher_email
    )
  );

-- Publisher can submit their own. Server routes validate the
-- manifest itself; RLS just enforces identity.
drop policy if exists partner_agents_publisher_insert on partner_agents;
create policy partner_agents_publisher_insert
  on partner_agents
  for insert
  with check (
    exists (
      select 1 from auth.users u
      where u.id = auth.uid() and u.email = partner_agents.publisher_email
    )
  );

-- ════════════════════════════════════════════════════════════════
-- db/migrations/011_app_store_runtime.sql
-- ════════════════════════════════════════════════════════════════

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

-- ════════════════════════════════════════════════════════════════
-- db/migrations/012_admin_settings.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 012 — admin settings + audit history.
--
-- Storage for the operator console's runtime knobs: LLM model,
-- voice provider/model/settings, system-prompt overrides, feature
-- flags. Anything an admin should be able to flip from /admin without
-- shipping a deploy lives here.
--
-- Two tables:
--
--   admin_settings           current value per key
--   admin_settings_history   one row per change, for rollback + audit
--
-- Why JSONB for value: settings are heterogeneous (string for model
-- ids, number for stability, object for voice_settings, boolean for
-- feature flags). One uniform shape avoids polymorphic columns.
-- Server-side getSetting<T> casts at read time; setSetting validates
-- before write.
--
-- Read access: admin route handlers using the service-role key.
-- RLS is on but no user-facing policies — settings are not visible
-- to end users.

create table if not exists public.admin_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create table if not exists public.admin_settings_history (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  value       jsonb not null,
  recorded_at timestamptz not null default now(),
  recorded_by text
);

create index if not exists admin_settings_history_key_recent
  on public.admin_settings_history (key, recorded_at desc);

alter table public.admin_settings enable row level security;
alter table public.admin_settings_history enable row level security;

-- No public policies — service role only. Admin routes go through
-- /api/admin/* which validate isAdmin() before reading/writing.
-- We deny everything by default; service role bypasses RLS.
drop policy if exists admin_settings_deny_all on public.admin_settings;
create policy admin_settings_deny_all
  on public.admin_settings
  for all
  using (false)
  with check (false);

drop policy if exists admin_settings_history_deny_all on public.admin_settings_history;
create policy admin_settings_history_deny_all
  on public.admin_settings_history
  for all
  using (false)
  with check (false);

-- Seed sensible defaults so a fresh install renders the settings
-- page with useful baselines instead of empty fields. These match
-- what app/api/tts/route.ts and lib/orchestrator.ts ship today.
insert into public.admin_settings (key, value, updated_by) values
  ('llm.model',         '"claude-opus-4-6"'::jsonb, 'system:default'),
  ('voice.provider',    '"elevenlabs"'::jsonb,      'system:default'),
  ('voice.model',       '"eleven_turbo_v2_5"'::jsonb, 'system:default'),
  ('voice.voice_id',    '"21m00Tcm4TlvDq8ikWAM"'::jsonb, 'system:default'),
  ('voice.stability',   '0.42'::jsonb,              'system:default'),
  ('voice.similarity_boost', '0.8'::jsonb,          'system:default'),
  ('voice.style',       '0.55'::jsonb,              'system:default'),
  ('feature.mcp_enabled', 'true'::jsonb,            'system:default'),
  ('feature.partner_agents_enabled', 'true'::jsonb, 'system:default'),
  ('feature.voice_mode_enabled', 'true'::jsonb,     'system:default'),
  ('feature.autonomy_enabled', 'false'::jsonb,      'system:default')
on conflict (key) do nothing;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/012_workspace_creator.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 012 — Workspace + creator-connector tables.
--
-- Backs the /workspace dashboard route plus the YouTube → Newsletter →
-- IG → FB → LinkedIn connector pack defined in
-- docs/specs/workspace-and-creator-connectors.md.
--
-- Six new tables, each scoped per-user, all idempotent, all RLS-ready
-- (RLS off for service-role-only tables; on for user-readable ones —
-- toggled below per table). Indexes are sized for the read patterns the
-- /workspace tabs need: by-user-and-platform, by-status-and-due,
-- append-only audit reads.
--
-- Why these six tables and not fewer:
--   1. connected_accounts        — sub-accounts under one OAuth grant
--                                   (a single Google grant exposes N
--                                   YouTube channels; one Meta grant
--                                   exposes N IG accounts + N FB pages).
--   2. connector_responses_archive — raw API payloads cached for graceful
--                                   degradation when tokens expire or
--                                   APIs return 5xx.
--   3. scheduled_posts           — publish queue for posts/replies the
--                                   user has staged but not yet
--                                   confirmation-card-approved.
--   4. media_assets              — uploaded images/video referenced by
--                                   scheduled_posts.media_refs.
--   5. audit_log_writes          — append-only record of every write
--                                   (post / reply / DM / schedule)
--                                   shipped to a platform.
--   6. pending_user_actions      — cron-fired due-publishes that need
--                                   the user to tap a notification and
--                                   confirm before going live.
--
-- The "one active connection per (user, agent)" model in
-- agent_connections (migration 004) stays as-is. A single grant covers
-- all sub-accounts; this migration just gives us a place to enumerate
-- and select between them.

-- ────────────────────────────────────────────────────────────────────
-- connected_accounts — sub-accounts under one OAuth grant
-- ────────────────────────────────────────────────────────────────────
--
-- One row per externally-distinct account the user has under a single
-- agent_connection. For YouTube: one row per channel the Google grant
-- can manage. For Meta: one row per IG Business/Creator account + one
-- row per FB Page. For LinkedIn: one row for personal profile + one
-- per Company page admin.
--
-- The `is_workspace_default` flag is what /workspace reads when the
-- user hasn't picked a sub-account in the header dropdown. Exactly one
-- row per (user_id, agent_id) carries the default flag — partial unique
-- index below.
--
-- We refresh the list opportunistically (on first dashboard mount + on
-- user-triggered "Refresh accounts" + on weekly cron). Stale rows are
-- soft-deleted via deleted_at so audit_log_writes can still resolve a
-- historical sub-account name.
create table if not exists public.connected_accounts (
  id                          text primary key,
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  agent_id                    text not null,
  -- Platform-side ID for this account/channel/page/profile.
  external_account_id         text not null,
  -- Display info — refreshed on each list call. Plain text, not a token.
  display_name                text not null,
  avatar_url                  text,
  account_type                text not null check (account_type in (
                                'youtube_channel',
                                'instagram_business',
                                'instagram_creator',
                                'facebook_page',
                                'linkedin_personal',
                                'linkedin_company',
                                'newsletter_publication',
                                'twitter_account',  -- reserved for V2
                                'other'
                              )),
  -- Free-form jsonb for platform-specific metadata: subscriber count,
  -- follower count, role on the page (admin/editor/etc), whatever the
  -- list endpoint returns that we want to surface in the picker.
  metadata                    jsonb not null default '{}'::jsonb,
  is_workspace_default        boolean not null default false,
  discovered_at               timestamptz not null default now(),
  last_seen_at                timestamptz not null default now(),
  deleted_at                  timestamptz,
  updated_at                  timestamptz not null default now()
);

-- Lookup: "give me all accounts under this user's connection to agent X"
create index if not exists connected_accounts_by_user_agent
  on public.connected_accounts (user_id, agent_id, last_seen_at desc)
  where deleted_at is null;

-- Reverse lookup for inbound webhooks (when IG/FB/YouTube notify us of
-- an event, they reference external_account_id; we need user_id quickly).
create index if not exists connected_accounts_by_external_id
  on public.connected_accounts (agent_id, external_account_id)
  where deleted_at is null;

-- Exactly one default per (user, agent). Partial unique so we can flip
-- defaults without violating; soft-deleted rows ignored.
create unique index if not exists connected_accounts_one_default
  on public.connected_accounts (user_id, agent_id)
  where is_workspace_default = true and deleted_at is null;

drop trigger if exists connected_accounts_touch_updated_at on public.connected_accounts;
create trigger connected_accounts_touch_updated_at
  before update on public.connected_accounts
  for each row execute function public.tg_touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- connector_responses_archive — graceful-degradation cache
-- ────────────────────────────────────────────────────────────────────
--
-- Every connector fetch (lib/connector-archive.ts) writes here on
-- success. Reads check this table first; if a row is within TTL, serve
-- it. If the live API fails, serve the most-recent row even past TTL
-- and flag the response as stale to the caller.
--
-- request_hash is a canonical sha256 of (agent_id, endpoint,
-- normalized_params) so we can dedupe equivalent requests.
--
-- response_body is jsonb because we do read-side analytics on the
-- archive (e.g., "show me the last 30 daily-views snapshots") and that
-- becomes possible only with structured storage.
--
-- We cap retention with a simple cron sweep (drop rows older than 90d
-- unless `keep_for_history` is true — set on snapshots we want to
-- preserve for trend analysis like daily channel stats).
create table if not exists public.connector_responses_archive (
  id                  bigserial primary key,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  agent_id            text not null,
  external_account_id text,
  endpoint            text not null,
  request_hash        text not null,
  response_status     integer not null,
  response_body       jsonb not null,
  fetched_at          timestamptz not null default now(),
  ttl_seconds         integer not null check (ttl_seconds > 0),
  keep_for_history    boolean not null default false
);

-- Hot path: the cache lookup. Filter by (user, agent, endpoint, hash)
-- and pick the latest fetched_at. Index covers all four.
create index if not exists connector_archive_lookup
  on public.connector_responses_archive
    (user_id, agent_id, endpoint, request_hash, fetched_at desc);

-- Trend-analysis path: time-series queries against snapshots.
create index if not exists connector_archive_history
  on public.connector_responses_archive
    (user_id, agent_id, endpoint, fetched_at desc)
  where keep_for_history = true;

-- Sweep path: "everything older than 90d not flagged for history."
create index if not exists connector_archive_sweep
  on public.connector_responses_archive (fetched_at)
  where keep_for_history = false;

-- ────────────────────────────────────────────────────────────────────
-- media_assets — uploaded images / video for posts
-- ────────────────────────────────────────────────────────────────────
--
-- Browser uploads via signed URL to Supabase Storage; the /api/media/
-- upload endpoint records one row here per upload. scheduled_posts.
-- media_refs is a jsonb array of media_assets.id values referenced
-- in publish order.
--
-- We store sha256 to dedupe re-uploads and enable platform-side hash
-- verification. mime_type drives the platform-side endpoint choice
-- (image vs video upload paths are different on every platform).
create table if not exists public.media_assets (
  id              text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  storage_path    text not null,           -- Supabase Storage path
  mime_type       text not null,
  size_bytes      bigint not null check (size_bytes > 0 and size_bytes <= 100 * 1024 * 1024),
  sha256          text not null,
  width_px        integer,
  height_px       integer,
  duration_ms     integer,                 -- video/audio only
  uploaded_at     timestamptz not null default now(),
  -- Soft delete; preserves historical post records that referenced it.
  deleted_at      timestamptz
);

create index if not exists media_assets_by_user
  on public.media_assets (user_id, uploaded_at desc)
  where deleted_at is null;

create index if not exists media_assets_by_sha
  on public.media_assets (user_id, sha256)
  where deleted_at is null;

-- ────────────────────────────────────────────────────────────────────
-- scheduled_posts — publish queue
-- ────────────────────────────────────────────────────────────────────
--
-- A user staging a post / reply / DM lands here first. The cron worker
-- /api/cron/publish-due-posts picks up rows where status = 'queued' and
-- scheduled_for <= now(), pushes them to pending_user_actions for
-- confirmation, and on confirm calls the platform API.
--
-- status lifecycle:
--   draft       — user is editing; not yet committed to a schedule
--   queued      — committed; waiting for scheduled_for to arrive
--   pending     — due-time hit; user notification sent; awaiting tap
--   posted      — successfully shipped to platform
--   failed      — platform rejected; error_text + platform_error_code captured
--   cancelled   — user cancelled before publish
--   expired     — pending state went 30 min unconfirmed; punted to Inbox
create table if not exists public.scheduled_posts (
  id                       text primary key,
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  agent_id                 text not null,
  external_account_id      text,                          -- which channel/page/profile
  -- Action type: drives platform-API choice.
  action_type              text not null check (action_type in (
                             'post', 'reply', 'comment_reply', 'dm', 'story', 'short'
                           )),
  -- Optional — populated for replies/comment_replies/threaded posts.
  in_reply_to_external_id  text,
  -- jsonb body keeps platform-specific fields without schema churn.
  -- Common shape: { text: "...", title?: "...", thumbnail_ref?: "...",
  -- visibility?: "public|private|unlisted", tags?: [...] }
  draft_body               jsonb not null,
  -- Array of media_assets.id values. Empty for text-only.
  media_refs               jsonb not null default '[]'::jsonb,
  -- User-local timezone-aware target time. Stored as timestamptz.
  -- The user-local display time is reconstructed from profiles.timezone.
  scheduled_for            timestamptz not null,
  -- User's timezone at the time of scheduling, frozen so display is
  -- stable even if the user later changes their profile timezone.
  user_timezone            text not null default 'UTC',
  status                   text not null default 'draft' check (status in (
                             'draft', 'queued', 'pending', 'posted',
                             'failed', 'cancelled', 'expired'
                           )),
  -- Confirmation-card lifecycle timestamps.
  confirmation_shown_at    timestamptz,
  confirmation_decided_at  timestamptz,
  confirmation_decision    text check (confirmation_decision in ('approved', 'rejected')),
  -- Platform outcome.
  posted_at                timestamptz,
  posted_external_id       text,                           -- the platform's URL or ID for this post
  platform_error_code      text,
  error_text               text,
  retry_count              integer not null default 0,
  -- Origin of the request — was this user-typed or AI-suggested? Used
  -- in audit + in the Operations tab.
  origin                   text not null default 'user' check (origin in (
                             'user', 'agent_suggestion', 'standing_intent', 'cron'
                           )),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Cron hot path: "what's due to publish in the next minute?"
create index if not exists scheduled_posts_due
  on public.scheduled_posts (scheduled_for)
  where status = 'queued';

-- Workspace tab read path: "show me my queue across all platforms."
create index if not exists scheduled_posts_by_user
  on public.scheduled_posts (user_id, scheduled_for desc);

-- "Today's posts" widget on Tab 1: anything posted in last 7d or
-- queued in next 7d.
create index if not exists scheduled_posts_today
  on public.scheduled_posts (user_id, status, scheduled_for desc);

drop trigger if exists scheduled_posts_touch_updated_at on public.scheduled_posts;
create trigger scheduled_posts_touch_updated_at
  before update on public.scheduled_posts
  for each row execute function public.tg_touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- audit_log_writes — every write that hit a platform
-- ────────────────────────────────────────────────────────────────────
--
-- Append-only. One row per platform write attempt — successful or
-- failed. Materially separate from scheduled_posts so the audit trail
-- survives even if scheduled_posts is purged.
--
-- The Operations tab reads this. So does any incident-response flow
-- ("did Lumo post anything to my account in the last hour?").
--
-- content_hash is sha256 of the literal text we submitted, so we can
-- prove what was sent without storing a duplicate of draft_body.
-- Original draft_body lives in scheduled_posts; this row references it.
create table if not exists public.audit_log_writes (
  id                       bigserial primary key,
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  scheduled_post_id        text references public.scheduled_posts(id) on delete set null,
  agent_id                 text not null,
  external_account_id      text,
  action_type              text not null,
  -- Confirmation context, captured at the moment of approval.
  confirmation_shown_at    timestamptz not null,
  confirmation_decided_at  timestamptz not null,
  confirmation_decision    text not null check (confirmation_decision in ('approved', 'rejected')),
  -- Platform call.
  platform_called_at       timestamptz,
  platform_response_code   integer,
  platform_response_id     text,                  -- post URL / ID
  ok                       boolean not null,
  error_text               text,
  -- What was submitted.
  content_hash             text not null,
  content_excerpt          text,                  -- first ~200 chars, for display
  origin                   text not null,
  created_at               timestamptz not null default now()
);

create index if not exists audit_log_writes_by_user_recent
  on public.audit_log_writes (user_id, created_at desc);

create index if not exists audit_log_writes_failures
  on public.audit_log_writes (user_id, created_at desc)
  where ok = false;

create index if not exists audit_log_writes_by_scheduled_post
  on public.audit_log_writes (scheduled_post_id);

-- ────────────────────────────────────────────────────────────────────
-- pending_user_actions — due-publishes awaiting user tap
-- ────────────────────────────────────────────────────────────────────
--
-- When the publish cron fires for a queued scheduled_post, we don't
-- bypass the confirmation card. Instead we push a row here, fire a
-- notification (via existing notifications.ts), and wait for the user
-- to tap → see the card → confirm or cancel.
--
-- expires_at = scheduled_for + 30 minutes. Past that, the cron sweeper
-- moves the scheduled_post to 'expired' and surfaces it in the Inbox
-- tab so the user can manually re-queue or discard.
create table if not exists public.pending_user_actions (
  id                  text primary key,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  scheduled_post_id   text not null references public.scheduled_posts(id) on delete cascade,
  notification_id     text,                                   -- notifications.id
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  resolved_at         timestamptz,
  resolution          text check (resolution in ('approved', 'cancelled', 'expired'))
);

-- Cron hot path: "what's expired since last run?"
create index if not exists pending_user_actions_expiry
  on public.pending_user_actions (expires_at)
  where resolved_at is null;

-- Inbox read path: "show me everything currently pending for this user."
create index if not exists pending_user_actions_by_user
  on public.pending_user_actions (user_id, created_at desc)
  where resolved_at is null;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/013_lumo_mission_gate.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 013 — Lumo mission permission gate.
--
-- The mission gate is an SSE-visible app-store checkpoint. It records which
-- marketplace apps Lumo asked the user to install/connect before continuing
-- a multi-agent task. Installs approved from that card use install_source =
-- 'lumo' so audit/reporting can distinguish proactive app discovery from a
-- manual marketplace click.

alter table public.user_agent_installs
  drop constraint if exists user_agent_installs_install_source_check;

alter table public.user_agent_installs
  add constraint user_agent_installs_install_source_check check (
    install_source in ('marketplace', 'oauth', 'admin', 'migration', 'lumo')
  );

alter table public.events
  drop constraint if exists events_frame_type_check;

alter table public.events
  add constraint events_frame_type_check check (
    frame_type in (
      'text',
      'mission',
      'tool',
      'selection',
      'summary',
      'leg_status',
      'error',
      'done',
      'request',
      'internal'
    )
  );

-- ════════════════════════════════════════════════════════════════
-- db/migrations/014_lumo_install_source_rename.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 014 — rename mission install provenance to Lumo.
--
-- This is intentionally tolerant of environments that already ran the
-- pre-rename migration and may have rows or permission snapshots with the
-- old source value.

alter table public.user_agent_installs
  drop constraint if exists user_agent_installs_install_source_check;

update public.user_agent_installs
set permissions = (permissions - 'jarvis') ||
  jsonb_build_object('lumo', permissions -> 'jarvis')
where permissions ? 'jarvis'
  and not permissions ? 'lumo';

update public.user_agent_installs
set install_source = 'lumo'
where install_source = 'jarvis';

alter table public.user_agent_installs
  add constraint user_agent_installs_install_source_check check (
    install_source in ('marketplace', 'oauth', 'admin', 'migration', 'lumo')
  );

-- ════════════════════════════════════════════════════════════════
-- db/migrations/015_content_embeddings.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 015 — Day 3 Intelligence Layer archive embeddings.
--
-- Lumo Core owns the indexer cron over connector_responses_archive; the
-- Lumo_ML_Service remains a stateless system-agent tool that only embeds
-- redacted text chunks. This table stores the resulting vectors for recall
-- and marketplace intelligence without mixing 384-dim ML-service embeddings
-- into the existing 1536-dim user_facts memory table.
--
-- Rollback, if this migration must be backed out before production data is
-- relied on:
--   drop function if exists public.next_connector_archive_embedding_batch(integer);
--   drop table if exists public.content_embedding_sources;
--   drop table if exists public.content_embeddings;

create extension if not exists vector;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.content_embeddings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  source_table      text not null,
  source_row_id     bigint not null,
  source_etag       text not null,
  chunk_index       integer not null check (chunk_index >= 0),
  source_agent_id   text,
  endpoint          text,
  request_hash      text,
  content_hash      text not null,
  text              text not null,
  metadata          jsonb not null default '{}'::jsonb,
  embedding         vector(384) not null,
  model             text not null,
  dimensions        integer not null default 384 check (dimensions = 384),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_table, source_row_id, source_etag, chunk_index)
);

create index if not exists content_embeddings_by_user_recent
  on public.content_embeddings (user_id, created_at desc);

create index if not exists content_embeddings_by_source
  on public.content_embeddings (source_table, source_row_id, source_etag);

create index if not exists content_embeddings_by_agent_endpoint
  on public.content_embeddings (user_id, source_agent_id, endpoint, created_at desc);

create index if not exists content_embeddings_vector_cosine
  on public.content_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

drop trigger if exists content_embeddings_touch_updated_at on public.content_embeddings;
create trigger content_embeddings_touch_updated_at
  before update on public.content_embeddings
  for each row execute function public.touch_updated_at();

-- One row per indexed archive source row. This is intentionally separate
-- from content_embeddings because some archive rows have no useful text; we
-- still need to mark them as processed so every cron run does not retry them.
create table if not exists public.content_embedding_sources (
  source_table    text not null,
  source_row_id   bigint not null,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  source_agent_id text,
  endpoint        text,
  source_etag     text not null,
  status          text not null check (status in ('embedded', 'no_text', 'failed')),
  chunk_count     integer not null default 0 check (chunk_count >= 0),
  last_error      text,
  indexed_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (source_table, source_row_id)
);

create index if not exists content_embedding_sources_retry
  on public.content_embedding_sources (status, updated_at)
  where status = 'failed';

create index if not exists content_embedding_sources_by_user
  on public.content_embedding_sources (user_id, indexed_at desc);

create index if not exists content_embedding_sources_by_agent
  on public.content_embedding_sources (user_id, source_agent_id, endpoint);

drop trigger if exists content_embedding_sources_touch_updated_at on public.content_embedding_sources;
create trigger content_embedding_sources_touch_updated_at
  before update on public.content_embedding_sources
  for each row execute function public.touch_updated_at();

create or replace function public.next_connector_archive_embedding_batch(
  requested_limit integer default 100
)
returns table (
  id bigint,
  user_id uuid,
  agent_id text,
  external_account_id text,
  endpoint text,
  request_hash text,
  response_status integer,
  response_body jsonb,
  fetched_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    a.id,
    a.user_id,
    a.agent_id,
    a.external_account_id,
    a.endpoint,
    a.request_hash,
    a.response_status,
    a.response_body,
    a.fetched_at
  from public.connector_responses_archive a
  left join public.content_embedding_sources s
    on s.source_table = 'connector_responses_archive'
   and s.source_row_id = a.id
  where
    s.source_row_id is null
    or (
      s.status = 'failed'
      and s.updated_at < now() - interval '1 hour'
    )
  order by a.fetched_at desc, a.id desc
  limit greatest(1, least(coalesce(requested_limit, 100), 500));
$$;

revoke all on function public.next_connector_archive_embedding_batch(integer) from public;
grant execute on function public.next_connector_archive_embedding_batch(integer) to service_role;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/016_content_recall.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 016 — Day 6 Intelligence Layer archive recall.
--
-- Adds a service-role-only vector search RPC over the redacted
-- content_embeddings table. Lumo Core calls this first, then sends the
-- bounded candidate set to Lumo_ML_Service /recall for lightweight reranking.
--
-- Rollback:
--   drop function if exists public.match_content_embeddings(uuid, vector(384), integer, text[]);

create or replace function public.match_content_embeddings(
  target_user uuid,
  query_embedding vector(384),
  match_count integer default 12,
  source_agent_ids text[] default null
)
returns table (
  id uuid,
  source_table text,
  source_row_id bigint,
  source_etag text,
  chunk_index integer,
  source_agent_id text,
  endpoint text,
  content_hash text,
  text text,
  metadata jsonb,
  score double precision,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    e.id,
    e.source_table,
    e.source_row_id,
    e.source_etag,
    e.chunk_index,
    e.source_agent_id,
    e.endpoint,
    e.content_hash,
    e.text,
    e.metadata,
    greatest(0, least(1, 1 - (e.embedding <=> query_embedding))) as score,
    e.created_at
  from public.content_embeddings e
  where
    e.user_id = target_user
    and (
      source_agent_ids is null
      or cardinality(source_agent_ids) = 0
      or e.source_agent_id = any(source_agent_ids)
    )
  order by e.embedding <=> query_embedding, e.created_at desc
  limit greatest(1, least(coalesce(match_count, 12), 50));
$$;

revoke all on function public.match_content_embeddings(uuid, vector(384), integer, text[]) from public;
grant execute on function public.match_content_embeddings(uuid, vector(384), integer, text[]) to service_role;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/017_audio_transcripts.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 017 — Sprint 0 audio uploads and Whisper transcripts.
--
-- Browser clients upload audio directly to a private Supabase Storage bucket.
-- Lumo Core then signs a short read URL for Lumo_ML_Service /transcribe,
-- stores the returned transcript, and lets the existing content indexer
-- embed redacted transcript chunks into content_embeddings for recall.
--
-- Rollback:
--   drop function if exists public.next_audio_transcript_embedding_batch(integer);
--   drop table if exists public.audio_transcripts;
--   drop table if exists public.audio_uploads;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'audio',
  'audio',
  false,
  209715200,
  array[
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/x-wav',
    'audio/webm',
    'audio/ogg',
    'audio/aac',
    'audio/flac',
    'audio/x-m4a',
    'video/mp4',
    'video/quicktime',
    'video/webm'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.audio_uploads (
  id              text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  bucket          text not null default 'audio',
  storage_path    text not null unique,
  mime_type       text not null,
  size_bytes      bigint not null check (size_bytes > 0 and size_bytes <= 200 * 1024 * 1024),
  sha256          text not null,
  duration_ms     integer,
  language        text,
  status          text not null default 'pending_upload' check (
                    status in ('pending_upload', 'uploaded', 'transcribing', 'transcribed', 'failed')
                  ),
  transcript_id   bigint,
  error_text      text,
  created_at      timestamptz not null default now(),
  uploaded_at     timestamptz,
  transcribed_at  timestamptz,
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists audio_uploads_by_user
  on public.audio_uploads (user_id, created_at desc)
  where deleted_at is null;

create index if not exists audio_uploads_by_status
  on public.audio_uploads (status, updated_at)
  where deleted_at is null and status in ('uploaded', 'transcribing', 'failed');

create index if not exists audio_uploads_by_sha
  on public.audio_uploads (user_id, sha256)
  where deleted_at is null;

drop trigger if exists audio_uploads_touch_updated_at on public.audio_uploads;
create trigger audio_uploads_touch_updated_at
  before update on public.audio_uploads
  for each row execute function public.touch_updated_at();

create table if not exists public.audio_transcripts (
  id                bigint generated by default as identity primary key,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  audio_upload_id   text not null references public.audio_uploads(id) on delete cascade,
  storage_path      text not null,
  transcript        text not null,
  segments          jsonb not null default '[]'::jsonb,
  language          text,
  duration_s        numeric,
  model             text not null,
  created_at        timestamptz not null default now(),
  unique (audio_upload_id)
);

create index if not exists audio_transcripts_by_user_recent
  on public.audio_transcripts (user_id, created_at desc);

create index if not exists audio_transcripts_by_upload
  on public.audio_transcripts (audio_upload_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'audio_uploads_transcript_fk'
      and conrelid = 'public.audio_uploads'::regclass
  ) then
    alter table public.audio_uploads
      add constraint audio_uploads_transcript_fk
      foreign key (transcript_id)
      references public.audio_transcripts(id)
      on delete set null;
  end if;
end $$;

create or replace function public.next_audio_transcript_embedding_batch(
  requested_limit integer default 100
)
returns table (
  id bigint,
  user_id uuid,
  audio_upload_id text,
  storage_path text,
  transcript text,
  segments jsonb,
  language text,
  duration_s numeric,
  model text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    t.id,
    t.user_id,
    t.audio_upload_id,
    t.storage_path,
    t.transcript,
    t.segments,
    t.language,
    t.duration_s,
    t.model,
    t.created_at
  from public.audio_transcripts t
  left join public.content_embedding_sources s
    on s.source_table = 'audio_transcripts'
   and s.source_row_id = t.id
  where
    auth.role() = 'service_role'
    and (
      s.source_row_id is null
      or (
        s.status = 'failed'
        and s.updated_at < now() - interval '1 hour'
      )
    )
  order by t.created_at desc, t.id desc
  limit greatest(1, least(coalesce(requested_limit, 100), 500));
$$;

revoke all on function public.next_audio_transcript_embedding_batch(integer) from public;
grant execute on function public.next_audio_transcript_embedding_batch(integer) to service_role;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/018_preference_events.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 018 — Sprint 0 preference event logging.
--
-- Captures lightweight product signals (impression, click, dwell,
-- dismiss) for chat suggestions, marketplace tiles, mission cards, and
-- workspace cards. These rows are training substrate only; no model or
-- recommender reads them yet.
--
-- Rollback:
--   drop table if exists public.preference_events;

create table if not exists public.preference_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  surface      text not null check (
                 surface in (
                   'chat_suggestion',
                   'marketplace_tile',
                   'mission_card',
                   'workspace_card'
                 )
               ),
  target_type  text not null check (
                 target_type in (
                   'suggestion',
                   'agent',
                   'mission_action',
                   'workspace_card',
                   'workspace_prompt'
                 )
               ),
  target_id    text not null,
  event_type   text not null check (
                 event_type in ('impression', 'click', 'dismiss', 'dwell')
               ),
  dwell_ms     integer check (dwell_ms is null or dwell_ms >= 0),
  session_id   text,
  context      jsonb not null default '{}'::jsonb,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  constraint preference_events_target_id_nonempty check (length(trim(target_id)) > 0)
);

create index if not exists preference_events_by_user_recent
  on public.preference_events (user_id, created_at desc);

create index if not exists preference_events_by_user_surface_recent
  on public.preference_events (user_id, surface, created_at desc);

create index if not exists preference_events_by_user_target_recent
  on public.preference_events (user_id, target_type, target_id, created_at desc);

create index if not exists preference_events_by_user_event_recent
  on public.preference_events (user_id, event_type, created_at desc);

alter table public.preference_events enable row level security;
revoke all on public.preference_events from anon, authenticated;
grant all on public.preference_events to service_role;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/019_pdf_documents.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 019 — Sprint 1 PDF document extraction and recall indexing.
--
-- Browser clients upload PDFs directly to a private Supabase Storage bucket.
-- Lumo Core signs a short read URL for Lumo_ML_Service /extract_pdf,
-- stores layout-aware pages/blocks, then indexes redacted page chunks into
-- content_embeddings with page_number metadata for recall citations.
--
-- Rollback:
--   drop function if exists public.next_pdf_document_embedding_batch(integer);
--   drop table if exists public.document_assets cascade;
--   drop table if exists public.pdf_documents cascade;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  104857600,
  array['application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.document_assets (
  id              text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  bucket          text not null default 'documents',
  storage_path    text not null unique,
  filename        text not null,
  mime_type       text not null default 'application/pdf',
  size_bytes      bigint not null check (size_bytes > 0 and size_bytes <= 100 * 1024 * 1024),
  sha256          text not null,
  status          text not null default 'pending_upload' check (
                    status in ('pending_upload', 'uploaded', 'extracting', 'extracted', 'failed')
                  ),
  pdf_document_id bigint,
  error_text      text,
  created_at      timestamptz not null default now(),
  uploaded_at     timestamptz,
  extracted_at    timestamptz,
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists document_assets_by_user
  on public.document_assets (user_id, created_at desc)
  where deleted_at is null;

create index if not exists document_assets_by_status
  on public.document_assets (status, updated_at)
  where deleted_at is null and status in ('uploaded', 'extracting', 'failed');

create index if not exists document_assets_by_sha
  on public.document_assets (user_id, sha256)
  where deleted_at is null;

drop trigger if exists document_assets_touch_updated_at on public.document_assets;
create trigger document_assets_touch_updated_at
  before update on public.document_assets
  for each row execute function public.touch_updated_at();

create table if not exists public.pdf_documents (
  id                bigint generated by default as identity primary key,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  document_asset_id text not null references public.document_assets(id) on delete cascade,
  storage_path      text not null,
  filename          text not null,
  pages             jsonb not null default '[]'::jsonb,
  total_pages       integer not null default 0 check (total_pages >= 0),
  language          text,
  created_at        timestamptz not null default now(),
  unique (document_asset_id)
);

create index if not exists pdf_documents_by_user_recent
  on public.pdf_documents (user_id, created_at desc);

create index if not exists pdf_documents_by_asset
  on public.pdf_documents (document_asset_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_assets_pdf_document_fk'
      and conrelid = 'public.document_assets'::regclass
  ) then
    alter table public.document_assets
      add constraint document_assets_pdf_document_fk
      foreign key (pdf_document_id)
      references public.pdf_documents(id)
      on delete set null;
  end if;
end $$;

create or replace function public.next_pdf_document_embedding_batch(
  requested_limit integer default 100
)
returns table (
  id bigint,
  user_id uuid,
  document_asset_id text,
  storage_path text,
  filename text,
  pages jsonb,
  total_pages integer,
  language text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    d.id,
    d.user_id,
    d.document_asset_id,
    d.storage_path,
    d.filename,
    d.pages,
    d.total_pages,
    d.language,
    d.created_at
  from public.pdf_documents d
  left join public.content_embedding_sources s
    on s.source_table = 'pdf_documents'
   and s.source_row_id = d.id
  where
    auth.role() = 'service_role'
    and (
      s.source_row_id is null
      or (
        s.status = 'failed'
        and s.updated_at < now() - interval '1 hour'
      )
    )
  order by d.created_at desc, d.id desc
  limit greatest(1, least(coalesce(requested_limit, 100), 500));
$$;

revoke all on function public.next_pdf_document_embedding_batch(integer) from public;
grant execute on function public.next_pdf_document_embedding_batch(integer) to service_role;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/020_image_embeddings.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 020 — Sprint 1 CLIP image embeddings and recall summaries.
--
-- Browser clients upload images directly to a private Supabase Storage bucket.
-- Lumo Core signs a short read URL for Lumo_ML_Service /embed_image, stores
-- CLIP's 512-dim vector separately, then indexes the redacted label summary
-- into content_embeddings so normal recall can cite visual assets.
--
-- Rollback:
--   drop function if exists public.next_image_embedding_text_batch(integer);
--   drop table if exists public.image_assets cascade;
--   drop table if exists public.image_embeddings cascade;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'images',
  'images',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.image_assets (
  id                 text primary key,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  bucket             text not null default 'images',
  storage_path       text not null unique,
  filename           text not null,
  mime_type          text not null,
  size_bytes         bigint not null check (size_bytes > 0 and size_bytes <= 25 * 1024 * 1024),
  sha256             text not null,
  width_px           integer,
  height_px          integer,
  status             text not null default 'pending_upload' check (
                       status in ('pending_upload', 'uploaded', 'embedding', 'embedded', 'failed')
                     ),
  image_embedding_id bigint,
  error_text         text,
  created_at         timestamptz not null default now(),
  uploaded_at        timestamptz,
  embedded_at        timestamptz,
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create index if not exists image_assets_by_user
  on public.image_assets (user_id, created_at desc)
  where deleted_at is null;

create index if not exists image_assets_by_status
  on public.image_assets (status, updated_at)
  where deleted_at is null and status in ('uploaded', 'embedding', 'failed');

create index if not exists image_assets_by_sha
  on public.image_assets (user_id, sha256)
  where deleted_at is null;

drop trigger if exists image_assets_touch_updated_at on public.image_assets;
create trigger image_assets_touch_updated_at
  before update on public.image_assets
  for each row execute function public.touch_updated_at();

create table if not exists public.image_embeddings (
  id                bigint generated by default as identity primary key,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  image_asset_id    text not null references public.image_assets(id) on delete cascade,
  storage_path      text not null,
  filename          text not null,
  mime_type         text not null,
  model             text not null,
  dimensions        integer not null default 512 check (dimensions > 0),
  embedding         vector(512) not null,
  labels            jsonb not null default '[]'::jsonb,
  summary_text      text not null,
  content_hash      text not null,
  created_at        timestamptz not null default now(),
  unique (image_asset_id)
);

create index if not exists image_embeddings_by_user_recent
  on public.image_embeddings (user_id, created_at desc);

create index if not exists image_embeddings_by_asset
  on public.image_embeddings (image_asset_id);

create index if not exists image_embeddings_vector_cosine
  on public.image_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'image_assets_image_embedding_fk'
      and conrelid = 'public.image_assets'::regclass
  ) then
    alter table public.image_assets
      add constraint image_assets_image_embedding_fk
      foreign key (image_embedding_id)
      references public.image_embeddings(id)
      on delete set null;
  end if;
end $$;

create or replace function public.next_image_embedding_text_batch(
  requested_limit integer default 100
)
returns table (
  id bigint,
  user_id uuid,
  image_asset_id text,
  storage_path text,
  filename text,
  mime_type text,
  model text,
  dimensions integer,
  labels jsonb,
  summary_text text,
  content_hash text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    e.id,
    e.user_id,
    e.image_asset_id,
    e.storage_path,
    e.filename,
    e.mime_type,
    e.model,
    e.dimensions,
    e.labels,
    e.summary_text,
    e.content_hash,
    e.created_at
  from public.image_embeddings e
  left join public.content_embedding_sources s
    on s.source_table = 'image_embeddings'
   and s.source_row_id = e.id
  where
    auth.role() = 'service_role'
    and (
      s.source_row_id is null
      or (
        s.status = 'failed'
        and s.updated_at < now() - interval '1 hour'
      )
    )
  order by e.created_at desc, e.id desc
  limit greatest(1, least(coalesce(requested_limit, 100), 500));
$$;

revoke all on function public.next_image_embedding_text_batch(integer) from public;
grant execute on function public.next_image_embedding_text_batch(integer) to service_role;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/021_proactive_moments.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 021 — Sprint 2 proactive moments substrate.
--
-- Three tables that Sprint 2's anomaly-detection + forecasting + proactive
-- moment surfacing layer writes to. Schema-only change; the tables stay
-- empty until Codex's anomaly/forecasting wrappers land and the
-- proactive-scan cron starts populating them.
--
-- time_series_metrics: per-user metric points over time (revenue, views,
-- engagement, etc.) ingested from connectors or computed by Lumo Core.
-- anomaly_findings: outliers detected against those time series.
-- proactive_moments: user-surface-able insights derived from anomaly
-- findings, forecasts, calendar context, or pattern recognition.
--
-- Rollback:
--   drop function if exists public.next_proactive_moment_for_user(uuid, integer);
--   drop table if exists public.proactive_moments;
--   drop table if exists public.anomaly_findings;
--   drop table if exists public.time_series_metrics;

create table if not exists public.time_series_metrics (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  metric_key      text not null,
  ts              timestamptz not null,
  value           double precision not null,
  dimensions      jsonb not null default '{}'::jsonb,
  source_agent_id text,
  created_at      timestamptz not null default now()
);

create index if not exists time_series_metrics_by_user_metric_ts
  on public.time_series_metrics (user_id, metric_key, ts desc);

create index if not exists time_series_metrics_by_user_recent
  on public.time_series_metrics (user_id, created_at desc);

alter table public.time_series_metrics enable row level security;
revoke all on public.time_series_metrics from anon, authenticated;
grant all on public.time_series_metrics to service_role;

create table if not exists public.anomaly_findings (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  metric_key         text not null,
  finding_type       text not null check (finding_type in ('spike', 'drop', 'level_shift', 'pattern_change')),
  detected_at        timestamptz not null default now(),
  anomaly_ts         timestamptz not null,
  expected_value     double precision,
  actual_value       double precision not null,
  z_score            double precision,
  confidence         double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status             text not null default 'new' check (status in ('new', 'acknowledged', 'dismissed', 'investigated')),
  model_version      text,
  evidence           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists anomaly_findings_by_user_status
  on public.anomaly_findings (user_id, status, detected_at desc);

create index if not exists anomaly_findings_by_user_metric
  on public.anomaly_findings (user_id, metric_key, detected_at desc);

drop trigger if exists anomaly_findings_touch_updated_at on public.anomaly_findings;
create trigger anomaly_findings_touch_updated_at
  before update on public.anomaly_findings
  for each row execute function public.touch_updated_at();

alter table public.anomaly_findings enable row level security;
revoke all on public.anomaly_findings from anon, authenticated;
grant all on public.anomaly_findings to service_role;

create table if not exists public.proactive_moments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  moment_type     text not null check (moment_type in (
                    'anomaly_alert', 'forecast_warning', 'pattern_observation',
                    'time_to_act', 'opportunity'
                  )),
  title           text not null,
  body            text not null,
  evidence        jsonb not null default '{}'::jsonb,
  urgency         text not null default 'medium' check (urgency in ('low', 'medium', 'high')),
  valid_from      timestamptz not null default now(),
  valid_until     timestamptz,
  status          text not null default 'pending' check (status in (
                    'pending', 'surfaced', 'acted_on', 'dismissed', 'expired'
                  )),
  surfaced_at     timestamptz,
  acted_on_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists proactive_moments_by_user_pending
  on public.proactive_moments (user_id, valid_from desc)
  where status = 'pending';

create index if not exists proactive_moments_by_user_recent
  on public.proactive_moments (user_id, created_at desc);

drop trigger if exists proactive_moments_touch_updated_at on public.proactive_moments;
create trigger proactive_moments_touch_updated_at
  before update on public.proactive_moments
  for each row execute function public.touch_updated_at();

alter table public.proactive_moments enable row level security;
revoke all on public.proactive_moments from anon, authenticated;
grant all on public.proactive_moments to service_role;

-- Service-role RPC: fetch the next batch of pending, still-valid proactive
-- moments for a user. The proactive-scan cron uses this to decide which
-- moments to surface; the workspace UI consumes the surfaced ones.
create or replace function public.next_proactive_moment_for_user(
  target_user uuid,
  requested_limit integer default 5
)
returns table (
  id uuid,
  moment_type text,
  title text,
  body text,
  evidence jsonb,
  urgency text,
  valid_from timestamptz,
  valid_until timestamptz,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    m.id,
    m.moment_type,
    m.title,
    m.body,
    m.evidence,
    m.urgency,
    m.valid_from,
    m.valid_until,
    m.created_at
  from public.proactive_moments m
  where
    m.user_id = target_user
    and m.status = 'pending'
    and (m.valid_until is null or m.valid_until > now())
  order by
    case m.urgency when 'high' then 0 when 'medium' then 1 else 2 end,
    m.valid_from desc
  limit greatest(1, least(coalesce(requested_limit, 5), 25));
$$;

revoke all on function public.next_proactive_moment_for_user(uuid, integer) from public;
grant execute on function public.next_proactive_moment_for_user(uuid, integer) to service_role;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/022_proactive_dedupe.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 022 — Atomic proactive-scan dedupe.
--
-- Vercel cron retries and manual triggers can overlap. Migration 021 created
-- the substrate, but the cron still needed database-backed uniqueness so
-- duplicate findings/moments cannot be created by parallel runs.
--
-- Rollback:
--   drop index if exists public.proactive_moments_active_dedup_key;
--   drop index if exists public.anomaly_findings_unique_detection;

with duplicate_anomaly_findings as (
  select
    id,
    row_number() over (
      partition by user_id, metric_key, finding_type, anomaly_ts
      order by created_at asc, id asc
    ) as rn
  from public.anomaly_findings
)
delete from public.anomaly_findings a
using duplicate_anomaly_findings d
where a.id = d.id and d.rn > 1;

create unique index if not exists anomaly_findings_unique_detection
  on public.anomaly_findings (user_id, metric_key, finding_type, anomaly_ts);

with duplicate_active_moments as (
  select
    id,
    row_number() over (
      partition by user_id, moment_type, (evidence ->> 'dedup_key')
      order by
        case status when 'surfaced' then 0 when 'pending' then 1 else 2 end,
        created_at asc,
        id asc
    ) as rn
  from public.proactive_moments
  where
    status in ('pending', 'surfaced')
    and nullif(evidence ->> 'dedup_key', '') is not null
)
update public.proactive_moments p
set
  status = 'expired',
  updated_at = now(),
  evidence = p.evidence || jsonb_build_object('expired_reason', 'duplicate_dedup_key')
from duplicate_active_moments d
where p.id = d.id and d.rn > 1;

create unique index if not exists proactive_moments_active_dedup_key
  on public.proactive_moments (user_id, moment_type, ((evidence ->> 'dedup_key')))
  where
    status in ('pending', 'surfaced')
    and nullif(evidence ->> 'dedup_key', '') is not null;

-- ════════════════════════════════════════════════════════════════
-- db/migrations/023_durable_missions.sql
-- ════════════════════════════════════════════════════════════════

-- Migration 023 — Sprint 3 durable mission execution substrate.
--
-- Phase 3 moves multi-agent work from one-shot chat responses into durable
-- missions that can pause for permissions, resume after OAuth/account setup,
-- require confirmation cards before side effects, and preserve an audit trail.
--
-- Rollback:
--   drop function if exists public.next_mission_step_for_execution(integer);
--   drop table if exists public.mission_execution_events;
--   drop table if exists public.mission_steps;
--   drop table if exists public.missions;

create table if not exists public.missions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  session_id  text,
  intent_text text not null,
  state       text not null default 'draft' check (state in (
                'draft',
                'awaiting_permissions',
                'awaiting_user_input',
                'ready',
                'executing',
                'awaiting_confirmation',
                'completed',
                'failed',
                'rolled_back'
              )),
  plan        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists missions_by_user_state_updated
  on public.missions (user_id, state, updated_at desc);

create index if not exists missions_by_session
  on public.missions (session_id, updated_at desc)
  where session_id is not null;

create index if not exists missions_ready_for_execution
  on public.missions (updated_at asc)
  where state = 'ready';

drop trigger if exists missions_touch_updated_at on public.missions;
create trigger missions_touch_updated_at
  before update on public.missions
  for each row execute function public.touch_updated_at();

alter table public.missions enable row level security;
revoke all on public.missions from anon, authenticated;
grant all on public.missions to service_role;

create table if not exists public.mission_steps (
  id                   uuid primary key default gen_random_uuid(),
  mission_id           uuid not null references public.missions(id) on delete cascade,
  step_order           integer not null check (step_order >= 0),
  agent_id             text not null,
  tool_name            text not null,
  reversibility        text not null check (reversibility in (
                         'reversible',
                         'compensating',
                         'irreversible'
                       )),
  status               text not null default 'pending' check (status in (
                         'pending',
                         'running',
                         'succeeded',
                         'failed',
                         'rolled_back',
                         'skipped'
                       )),
  inputs               jsonb not null default '{}'::jsonb,
  outputs              jsonb not null default '{}'::jsonb,
  confirmation_card_id text,
  started_at           timestamptz,
  finished_at          timestamptz,
  error_text           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (mission_id, step_order)
);

create index if not exists mission_steps_by_mission_order
  on public.mission_steps (mission_id, step_order asc);

create index if not exists mission_steps_by_status
  on public.mission_steps (status, created_at asc);

create index if not exists mission_steps_by_agent_tool
  on public.mission_steps (agent_id, tool_name, created_at desc);

drop trigger if exists mission_steps_touch_updated_at on public.mission_steps;
create trigger mission_steps_touch_updated_at
  before update on public.mission_steps
  for each row execute function public.touch_updated_at();

alter table public.mission_steps enable row level security;
revoke all on public.mission_steps from anon, authenticated;
grant all on public.mission_steps to service_role;

create table if not exists public.mission_execution_events (
  id         bigint generated by default as identity primary key,
  mission_id uuid not null references public.missions(id) on delete cascade,
  step_id    uuid references public.mission_steps(id) on delete set null,
  event_type text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists mission_execution_events_by_mission
  on public.mission_execution_events (mission_id, created_at asc);

create index if not exists mission_execution_events_by_step
  on public.mission_execution_events (step_id, created_at asc)
  where step_id is not null;

create index if not exists mission_execution_events_by_type
  on public.mission_execution_events (event_type, created_at desc);

alter table public.mission_execution_events enable row level security;
revoke all on public.mission_execution_events from anon, authenticated;
grant all on public.mission_execution_events to service_role;
grant usage, select on sequence public.mission_execution_events_id_seq to service_role;

-- Service-role RPC: atomically claim the next runnable mission steps. A step
-- is runnable only when its mission is ready/executing and all prior steps in
-- the mission have either succeeded or been intentionally skipped.
create or replace function public.next_mission_step_for_execution(
  requested_limit integer default 10
)
returns table (
  id uuid,
  mission_id uuid,
  user_id uuid,
  step_order integer,
  agent_id text,
  tool_name text,
  reversibility text,
  inputs jsonb,
  confirmation_card_id text
)
language sql
security definer
set search_path = public
as $$
  with runnable as (
    select s.id
    from public.mission_steps s
    join public.missions m on m.id = s.mission_id
    where
      auth.role() = 'service_role'
      and m.state in ('ready', 'executing')
      and s.status = 'pending'
      and not exists (
        select 1
        from public.mission_steps prior
        where
          prior.mission_id = s.mission_id
          and prior.step_order < s.step_order
          and prior.status not in ('succeeded', 'skipped')
      )
    order by m.updated_at asc, s.step_order asc
    for update of s skip locked
    limit greatest(1, least(coalesce(requested_limit, 10), 50))
  ),
  claimed as (
    update public.mission_steps s
    set
      status = 'running',
      started_at = coalesce(s.started_at, now()),
      updated_at = now()
    from runnable r
    where s.id = r.id
    returning
      s.id,
      s.mission_id,
      s.step_order,
      s.agent_id,
      s.tool_name,
      s.reversibility,
      s.inputs,
      s.confirmation_card_id
  ),
  touched_missions as (
    update public.missions m
    set
      state = 'executing',
      updated_at = now()
    from (select distinct mission_id from claimed) c
    where
      m.id = c.mission_id
      and m.state = 'ready'
    returning m.id
  )
  select
    c.id,
    c.mission_id,
    m.user_id,
    c.step_order,
    c.agent_id,
    c.tool_name,
    c.reversibility,
    c.inputs,
    c.confirmation_card_id
  from claimed c
  join public.missions m on m.id = c.mission_id
  order by m.updated_at asc, c.step_order asc;
$$;

revoke all on function public.next_mission_step_for_execution(integer) from public;
grant execute on function public.next_mission_step_for_execution(integer) to service_role;
