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
