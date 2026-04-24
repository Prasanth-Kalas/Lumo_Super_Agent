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
