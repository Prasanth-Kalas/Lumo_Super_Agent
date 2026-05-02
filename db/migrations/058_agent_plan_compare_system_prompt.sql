-- Migration 058 — SYSTEM-PROMPT-MIGRATE-PYTHON-1 telemetry extension.
--
-- Extends agent_plan_compare (migration 054 base + 057 suggestions)
-- with three columns that capture system-prompt output from both
-- stacks plus a Levenshtein ratio of the per-turn agreement.
--
-- Semantic notes (codex's plan-client logger fills these in):
--
--   system_prompt_python  Full Python-built canonical system prompt
--                         from /api/tools/plan response.full_system_
--                         prompt. Null when the request didn't carry
--                         the inputs needed (user_region defaults to
--                         "US", but if the orchestrator wires its
--                         own field absence detection, NULL is used
--                         to record "not generated this turn").
--
--   system_prompt_ts      Full TS-built system prompt from
--                         apps/web/lib/system-prompt.ts:buildSystem
--                         Prompt() emission path. Null when the
--                         orchestrator didn't run the TS builder
--                         (cold-start, edge cases).
--
--   system_prompt_levenshtein_ratio
--                         Per-turn character-level Levenshtein ratio
--                         in [0, 1]. 1.0 = identical strings; 0.0 =
--                         totally different. Computed server-side by
--                         the plan-client logger using e.g.
--                         difflib.SequenceMatcher (Python) or any
--                         comparable JS lib. Null when either side
--                         is null (ratio undefined).
--
-- Storage volume: full prompts are 1500–2500 tokens (~6 KB each side),
-- so ~12 KB/row. At 100k turns/day this is ~1.2 GB/day of capture.
-- Reviewer's plan: bootstrap with full text for 7 days, switch to
-- hashes once cutover decision lands. Acceptable for the bootstrap
-- window.
--
-- Append-only invariant from 054 still holds: row trigger prevents
-- UPDATE / DELETE; ALTER TABLE … ADD COLUMN is metadata-only and
-- bypasses the trigger. Existing rows backfill from defaults: NULL
-- for all three columns.
--
-- Rollback:
--   alter table public.agent_plan_compare
--     drop column if exists system_prompt_levenshtein_ratio,
--     drop column if exists system_prompt_ts,
--     drop column if exists system_prompt_python;

alter table public.agent_plan_compare
  add column if not exists system_prompt_python text,
  add column if not exists system_prompt_ts     text,
  add column if not exists system_prompt_levenshtein_ratio real
    check (system_prompt_levenshtein_ratio is null or (system_prompt_levenshtein_ratio >= 0 and system_prompt_levenshtein_ratio <= 1));

comment on column public.agent_plan_compare.system_prompt_python is
  'Python-built canonical system prompt for this turn. Full text; ~6 KB typical. Null when /api/tools/plan didn''t produce one.';
comment on column public.agent_plan_compare.system_prompt_ts is
  'TS-built canonical system prompt for this turn from buildSystemPrompt() emission path. Full text; ~6 KB typical.';
comment on column public.agent_plan_compare.system_prompt_levenshtein_ratio is
  'Character-level Levenshtein ratio in [0, 1] of the two system prompts. Computed server-side by the plan-client logger. Null when either side is null.';
