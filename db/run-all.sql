-- Lumo Super Agent — run-all migrations (generated)
-- Concatenation of db/migrations/001...008 in order. Safe to re-run:
-- every CREATE uses IF NOT EXISTS and every ALTER uses ADD COLUMN IF NOT EXISTS.
-- Paste this whole file into Supabase → SQL Editor → Run.

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
-- This is the foundation of the "JARVIS-like" loop: the Super Agent stops
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

-- At-most-one LIVE notification per (user, dedup_key). "Live" means:
-- unread AND not yet expired. Once a user reads it OR expiry passes, the
-- partial predicate no longer holds and the same rule can re-fire.
create unique index if not exists notifications_one_live_per_dedup
  on public.notifications (user_id, dedup_key)
  where read_at is null and (expires_at is null or expires_at > now());

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

