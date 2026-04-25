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
