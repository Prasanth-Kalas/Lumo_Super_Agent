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
