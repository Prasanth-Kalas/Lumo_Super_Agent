-- Migration 031 — WAKE-1 wake-word per-user settings + telemetry.
--
-- Codex fills the body for WAKE-1. This file is the scaffold: wake_word_settings
-- per-user row (off by default per ADR-010 §6), model versioning so we can
-- ship per-user model upgrades without re-prompting consent, and counters for
-- TPR / FAR telemetry that feed the held-out evaluation set (ADR-010 §5).
--
-- Related:
--   - docs/specs/adr-010-wake-word-engine.md (sealed)
--   - docs/specs/phase-3-master.md §5 (WAKE-1 deliverable)
--   - tests/phase3-wake-word-privacy.test.mjs
--   - lib/wake-word/engine.ts (Codex implements behind the engine interface)
--
-- Open schema decisions escalated to Kalas:
--   - Do we want per-user sensitivity slider (3 levels) persisted here?
--     ADR-010 §10 mentions it as a Phase-3 mitigation. Scaffold includes it
--     as `sensitivity` int 1..3 default 2. Confirm before merge.
--
-- Rollback:
--   drop index if exists public.wake_word_settings_enabled;
--   drop table if exists public.wake_word_settings;

create table if not exists public.wake_word_settings (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null unique references public.profiles(id) on delete cascade,
  enabled                boolean not null default false,                  -- ADR-010 §6.1: off by default
  engine                 text not null default 'custom_cnn' check (engine in (
                           'custom_cnn',           -- v1 default, on-device
                           'openwakeword',
                           'porcupine'             -- paid fallback, gated
                         )),
  model_version          text,
  sensitivity            integer not null default 2 check (sensitivity between 1 and 3),
  last_calibrated_at     timestamptz,
  last_enabled_at        timestamptz,
  last_disabled_at       timestamptz,
  -- Telemetry counters (ADR-010 §5). Counts only; never raw audio.
  true_positive_count    integer not null default 0 check (true_positive_count >= 0),
  false_accept_count     integer not null default 0 check (false_accept_count >= 0),
  fired_total_count      integer not null default 0 check (fired_total_count >= 0),
  -- Idle-sleep / battery suspend bookkeeping (ADR-010 §6.3).
  last_fired_at          timestamptz,
  auto_suspended_reason  text check (auto_suspended_reason in (
                           'idle_30min',
                           'low_battery',
                           'tab_background',
                           'mic_revoked',
                           'engine_error'
                         ) or auto_suspended_reason is null),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists wake_word_settings_enabled
  on public.wake_word_settings (enabled, last_fired_at desc)
  where enabled = true;

drop trigger if exists wake_word_settings_touch_updated_at on public.wake_word_settings;
create trigger wake_word_settings_touch_updated_at
  before update on public.wake_word_settings
  for each row execute function public.touch_updated_at();

alter table public.wake_word_settings enable row level security;
revoke all on public.wake_word_settings from anon, authenticated;
grant all on public.wake_word_settings to service_role;

-- Note: wake-word enable/disable also writes a row to consent_audit_log
-- (action='wake_word_enabled' / 'wake_word_disabled' / 'interrupted_listening')
-- per ADR-010 §6.1, using the audit table created in 030_voice_consent_audit.sql.
