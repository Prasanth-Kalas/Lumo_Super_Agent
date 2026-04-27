-- Migration 030 — VOICE-1 voice clones + biometric consent audit log.
--
-- Codex fills the body for VOICE-1. This file is the scaffold: voice_clones
-- (one per user, encrypted voice_id, status state machine per ADR-012 §3),
-- consent_audit_log (append-only, with the action enum from ADR-012 §2.3),
-- and partitioning hint for 7-year retention (BIPA buffer per ADR-012 §7).
-- Codex adds the helper RPCs request_voice_id_for_tts and revoke_voice_clone
-- under this scaffold.
--
-- Related:
--   - docs/specs/adr-012-voice-cloning-biometric-consent.md (sealed)
--   - docs/specs/phase-3-master.md §4 (VOICE-1 deliverable)
--   - tests/phase3-voice-consent.test.mjs (verifies all 8 invariants)
--   - app/onboarding/voice/* (Coworker C — DO NOT TOUCH)
--   - components/voice/* (Coworker C — DO NOT TOUCH)
--
-- 8 invariants enforced (ADR-012 §2):
--   2.1 No default-on
--   2.2 No incidental cloning (per-bucket isolation; runtime, not schema)
--   2.3 Strict audit trail (this table; APPEND-ONLY)
--   2.4 Sample retention bound (24h purge cron; runtime + voice_sample_purged action)
--   2.5 Owner-only (unique on user_id; cloning RPC checks JWT match)
--   2.6 Revocation 7-day SLA (status state machine + cron job)
--   2.7 Use disclosure (voice_clone_used row per call)
--   2.8 Storage encryption (voice_id_encrypted bytea via pgcrypto)
--
-- Open schema decisions escalated to Kalas:
--   - Whether to physically partition consent_audit_log by month for the
--     7-year retention story. Scaffold creates a partition-ready table but
--     does not declare partitions — Codex enables partitioning post-launch
--     if row volume warrants. Confirm posture.
--   - pgcrypto symmetric key handling. Scaffold assumes a service-role
--     setting `app.voice_clone_key` resolved at runtime. Confirm key rotation
--     plan before merge.
--
-- Rollback:
--   drop function if exists public.revoke_voice_clone(uuid);
--   drop function if exists public.request_voice_id_for_tts(uuid, text, text, text);
--   drop trigger  if exists consent_audit_log_no_update on public.consent_audit_log;
--   drop trigger  if exists consent_audit_log_no_delete on public.consent_audit_log;
--   drop function if exists public.consent_audit_log_append_only();
--   drop index    if exists public.consent_audit_log_voice;
--   drop index    if exists public.consent_audit_log_user;
--   drop index    if exists public.voice_clones_deletion_pending;
--   drop index    if exists public.voice_clones_status;
--   drop table    if exists public.consent_audit_log;
--   drop table    if exists public.voice_clones;

create extension if not exists pgcrypto;

create table if not exists public.voice_clones (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null unique references public.profiles(id) on delete cascade,
  voice_id_encrypted       bytea not null,
  engine                   text not null default 'self_hosted' check (engine in (
                             'self_hosted',          -- XTTS / Coqui per ADR-012
                             'third_party_fallback'
                           )),
  status                   text not null default 'active' check (status in (
                             'active',
                             'pending_deletion',
                             'failed',
                             'deleted'
                           )),
  consent_version          text not null,
  created_at               timestamptz not null default now(),
  last_used_at             timestamptz,
  deletion_requested_at    timestamptz,
  deletion_completed_at    timestamptz
);

create index if not exists voice_clones_status
  on public.voice_clones (status);

create index if not exists voice_clones_deletion_pending
  on public.voice_clones (deletion_requested_at)
  where status = 'pending_deletion';

alter table public.voice_clones enable row level security;
revoke all on public.voice_clones from anon, authenticated;
grant all on public.voice_clones to service_role;

-- Append-only audit log. ADR-012 §2.3 enumerates the required actions.
-- Partition-ready (no partition declared in v1; revisit if row volume
-- exceeds ~10M rows or if 7-year retention requires hot/cold split).
create table if not exists public.consent_audit_log (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  action               text not null check (action in (
                         'consent_granted',
                         'consent_revoked',
                         'voice_clone_created',
                         'voice_clone_used',
                         'voice_clone_use_disclosed',
                         'voice_clone_accessed',
                         'voice_clone_deleted',
                         'voice_clone_deletion_failed',
                         'voice_sample_purged',
                         'wake_word_enabled',
                         'wake_word_disabled',
                         'interrupted_listening'
                       )),
  voice_id             text,                              -- redacted/hashed; never the raw decrypted id
  ip_address           inet,
  user_agent           text,
  evidence_payload     jsonb not null default '{}'::jsonb,
  consent_text_hash    text,
  created_by           text not null default 'service' check (created_by in (
                         'user',
                         'system',
                         'admin',
                         'service'
                       )),
  created_at           timestamptz not null default now(),
  unique (user_id, action, created_at, voice_id)
);

create index if not exists consent_audit_log_user
  on public.consent_audit_log (user_id, created_at desc);

create index if not exists consent_audit_log_voice
  on public.consent_audit_log (voice_id)
  where voice_id is not null;

-- ADR-012 §2.3: append-only. Updates and deletes raise. Account-deletion
-- cascades are handled via the FK on user_id (the only allowed delete path).
create or replace function public.consent_audit_log_append_only()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'UPDATE') then
    raise exception 'consent_audit_log is append-only; updates forbidden';
  elsif (tg_op = 'DELETE') then
    -- Allow only the cascade from profiles. If invoked outside of a
    -- profile-cascade context, raise. Codex hardens this check at merge time.
    if current_setting('lumo.allow_consent_audit_delete', true) <> 'true' then
      raise exception 'consent_audit_log is append-only; direct deletes forbidden';
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists consent_audit_log_no_update on public.consent_audit_log;
create trigger consent_audit_log_no_update
  before update on public.consent_audit_log
  for each row execute function public.consent_audit_log_append_only();

drop trigger if exists consent_audit_log_no_delete on public.consent_audit_log;
create trigger consent_audit_log_no_delete
  before delete on public.consent_audit_log
  for each row execute function public.consent_audit_log_append_only();

alter table public.consent_audit_log enable row level security;
revoke all on public.consent_audit_log from anon, authenticated;
grant all on public.consent_audit_log to service_role;

-- Codex fills:
--   create or replace function public.request_voice_id_for_tts(
--     p_user_id uuid, p_request_id text, p_surface text, p_caller_agent_id text
--   ) returns text
--     language plpgsql security definer ...
--     -- decrypt voice_id_encrypted via pgp_sym_decrypt; write
--     -- voice_clone_used audit row in same transaction.
--   create or replace function public.revoke_voice_clone(p_user_id uuid)
--     returns void
--     language plpgsql security definer ...
--     -- set status='pending_deletion'; write consent_revoked audit row;
--     -- enqueue deletion job (cron picks up).
