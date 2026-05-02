-- Migration 056 — DEEPGRAM-MIGRATION-1 voice provider comparison telemetry.
--
-- Mirrors the parallel-write telemetry pattern from agent_plan_compare:
-- during the provider cutover window, server-side audio routes write bounded
-- latency/error evidence for STT and TTS without storing raw audio, prompts,
-- transcripts, or provider secrets.
--
-- Rollback:
--   drop trigger if exists voice_provider_compare_append_only_guard on public.voice_provider_compare;
--   drop function if exists public.voice_provider_compare_append_only();
--   drop index if exists public.voice_provider_compare_by_direction_created;
--   drop index if exists public.voice_provider_compare_by_provider_created;
--   drop index if exists public.voice_provider_compare_by_created;
--   drop table if exists public.voice_provider_compare;

create table if not exists public.voice_provider_compare (
  id                     bigint generated always as identity primary key,
  provider               text not null
                           check (provider in ('deepgram','elevenlabs')),
  direction              text not null
                           check (direction in ('stt','tts')),
  latency_first_token_ms integer
                           check (
                             latency_first_token_ms is null
                             or latency_first_token_ms >= 0
                           ),
  total_audio_ms         integer
                           check (
                             total_audio_ms is null
                             or total_audio_ms >= 0
                           ),
  audio_bytes            bigint
                           check (
                             audio_bytes is null
                             or audio_bytes >= 0
                           ),
  error                  text
                           check (
                             error is null
                             or (
                               char_length(error) between 1 and 240
                               and error !~ '[[:cntrl:]]'
                             )
                           ),
  session_id             text
                           check (
                             session_id is null
                             or (
                               char_length(session_id) between 1 and 200
                               and session_id !~ '[[:space:]]'
                             )
                           ),
  user_id                uuid references public.profiles(id) on delete set null,
  created_at             timestamptz not null default now(),
  check (
    latency_first_token_ms is not null
    or total_audio_ms is not null
    or audio_bytes is not null
    or error is not null
  )
);

comment on table public.voice_provider_compare is
  'DEEPGRAM-MIGRATION-1 append-only STT/TTS provider telemetry. Stores only bounded latency/error metadata; never raw audio, transcripts, prompts, or provider keys.';
comment on column public.voice_provider_compare.provider is
  'Provider measured during the cutover window. ElevenLabs remains only as the temporary fallback provider.';
comment on column public.voice_provider_compare.direction is
  'Audio direction: stt for speech-to-text, tts for text-to-speech.';
comment on column public.voice_provider_compare.latency_first_token_ms is
  'Time to first audio/transcript token/chunk when available.';
comment on column public.voice_provider_compare.total_audio_ms is
  'Total provider call or stream duration in milliseconds.';
comment on column public.voice_provider_compare.audio_bytes is
  'Input or output byte count. Not raw audio content.';
comment on column public.voice_provider_compare.error is
  'Short machine-readable error code. No raw upstream body or user content.';

create index if not exists voice_provider_compare_by_created
  on public.voice_provider_compare (created_at desc);

create index if not exists voice_provider_compare_by_provider_created
  on public.voice_provider_compare (provider, created_at desc);

create index if not exists voice_provider_compare_by_direction_created
  on public.voice_provider_compare (direction, created_at desc);

create or replace function public.voice_provider_compare_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    raise exception 'VOICE_PROVIDER_COMPARE_APPEND_ONLY'
      using hint = 'Insert a new voice-provider telemetry row instead of mutating historical cutover evidence.';
  end if;

  if (tg_op = 'DELETE') then
    if current_setting('lumo.allow_voice_provider_compare_delete', true) <> 'true' then
      raise exception 'VOICE_PROVIDER_COMPARE_DELETE_FORBIDDEN'
        using hint = 'Voice-provider telemetry is append-only except retention/privacy jobs.';
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists voice_provider_compare_append_only_guard on public.voice_provider_compare;
create trigger voice_provider_compare_append_only_guard
  before update or delete on public.voice_provider_compare
  for each row execute function public.voice_provider_compare_append_only();

alter table public.voice_provider_compare enable row level security;

revoke all on public.voice_provider_compare from anon, authenticated;
grant select, insert, delete on public.voice_provider_compare to service_role;
grant usage, select on sequence public.voice_provider_compare_id_seq to service_role;

-- Admin reads are intentionally mediated through service-role API routes after
-- application-level admin checks. Browser clients get no direct PostgREST
-- policy for this cutover telemetry table.
