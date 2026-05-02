-- Migration 057 — SUGGESTIONS-MIGRATE-PYTHON-1 telemetry extension.
--
-- Extends agent_plan_compare (migration 054) with three columns that
-- capture suggestion-chip output from both stacks and a Jaccard score
-- of the per-turn agreement.
--
-- Semantic notes (codex's plan-client logger fills these in):
--
--   suggestions_python  Python's chip set for this turn. Empty array
--                       (default '{}') when build_assistant_suggestions
--                       short-circuits — i.e. needsUserDecision === false,
--                       free-text identity ask, or post-dedupe count < 2.
--                       The Python wire returns [] in those cases (the
--                       TS reference returns a null SSE frame; codex's
--                       plan-client treats null and [] as equivalent
--                       per recon §11.5).
--
--   suggestions_ts      TS chip set for this turn from the existing
--                       buildAssistantSuggestions() emission path.
--                       Empty array when the TS code returned null.
--
--   suggestions_jaccard Per-turn Jaccard over the LABEL set of the two
--                       arrays — labels are user-facing and stable
--                       across cosmetic-only refactors. Null when both
--                       arrays are empty (Jaccard undefined for
--                       0/0). Codex's logger computes this server-side
--                       at insert time.
--
-- Append-only invariant from 054 still holds — no UPDATE / DELETE is
-- permitted at the table level, but ALTER TABLE … ADD COLUMN bypasses
-- the row trigger and is a metadata-only operation. Existing rows
-- backfill with the column defaults: '{}' for the array columns, NULL
-- for the Jaccard column.
--
-- Rollback:
--   alter table public.agent_plan_compare
--     drop column if exists suggestions_jaccard,
--     drop column if exists suggestions_ts,
--     drop column if exists suggestions_python;

alter table public.agent_plan_compare
  add column if not exists suggestions_python text[] not null default '{}',
  add column if not exists suggestions_ts     text[] not null default '{}',
  add column if not exists suggestions_jaccard real
    check (suggestions_jaccard is null or (suggestions_jaccard >= 0 and suggestions_jaccard <= 1));

comment on column public.agent_plan_compare.suggestions_python is
  'Suggestion-chip labels emitted by the Python /api/tools/plan response. Empty array when no chips qualified or last_assistant_message was absent.';
comment on column public.agent_plan_compare.suggestions_ts is
  'Suggestion-chip labels emitted by the TypeScript buildAssistantSuggestions() path. Empty array when the TS reference returned null (no SSE frame).';
comment on column public.agent_plan_compare.suggestions_jaccard is
  'Per-turn Jaccard over label sets, computed server-side by the plan-client logger. Null when both arrays are empty.';
