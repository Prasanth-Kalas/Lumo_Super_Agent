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
