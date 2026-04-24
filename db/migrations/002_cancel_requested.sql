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
