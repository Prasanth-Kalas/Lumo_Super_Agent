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
