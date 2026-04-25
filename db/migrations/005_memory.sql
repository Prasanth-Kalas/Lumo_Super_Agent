-- Migration 005 — J1 Memory + J4 Ambient Context.
--
-- This is the foundation of the "Lumo-like" loop: the Super Agent stops
-- forgetting the user between sessions. Three tables, each with a narrow
-- responsibility:
--
--   user_profile            — structured, user-editable preferences and
--                             identity. One row per user. The source of
--                             truth for home/work addresses, dietary flags,
--                             travel preferences, etc.
--
--   user_facts              — append-only free-text memories extracted by
--                             Claude during conversation. Semantically
--                             searchable via pgvector embeddings. Soft-
--                             delete (deleted_at) so a user's "forget that"
--                             is recoverable for 30 days.
--
--   user_behavior_patterns  — aggregations built offline from the events
--                             table ("user orders pizza on Friday
--                             evenings", "user travels NYC→LA monthly").
--                             Rebuilt by a nightly job (not yet wired).
--
-- Privacy posture: every row here is per-user, no cross-user joins, no
-- PII in indexes. Soft-delete preserves audit trail but the user's
-- /memory UI filters deleted rows out. A full hard-delete ("wipe
-- everything Lumo knows about me") is a one-line DELETE that cascades
-- via profiles(id) ON DELETE CASCADE.
--
-- pgvector: we use text-embedding-3-small (1536 dims) via OpenAI. If the
-- OPENAI_API_KEY isn't set the memory layer degrades to recency-only
-- retrieval — the column stays nullable on purpose to support that path.

-- ────────────────────────────────────────────────────────────────────
-- Extensions
-- ────────────────────────────────────────────────────────────────────
create extension if not exists vector;

-- ────────────────────────────────────────────────────────────────────
-- user_profile — structured, editable
-- ────────────────────────────────────────────────────────────────────
-- Kept narrow in v1. Adding a new field is cheap; removing one is
-- expensive because of UI code paths — so we hold the line on "structured
-- fields are for things with obvious shape and obvious privacy story".
-- Anything fuzzier goes in user_facts.
--
-- Addresses are jsonb rather than exploded columns so an agent that
-- needs delivery coords gets the whole object in one read, and schema
-- evolution (adding apartment_number, floor, gate_code) doesn't need a
-- migration.
create table if not exists public.user_profile (
  id                           uuid primary key references public.profiles(id) on delete cascade,

  -- Identity / locale
  display_name                 text,
  timezone                     text,
  preferred_language           text,

  -- Canonical addresses. Shape:
  --   { "label": "Home", "line1": "...", "city": "...", "region": "...",
  --     "country": "...", "postal_code": "...",
  --     "coords": { "lat": 37.77, "lng": -122.41 } }
  home_address                 jsonb,
  work_address                 jsonb,

  -- Dietary + health. text[] for set semantics and easy contains-check.
  dietary_flags                text[] not null default '{}',
  allergies                    text[] not null default '{}',
  preferred_cuisines           text[] not null default '{}',

  -- Travel
  preferred_airline_class      text,   -- "economy" | "premium_economy" | "business" | "first"
  preferred_airline_seat       text,   -- "aisle" | "window" | "middle" | "any"
  frequent_flyer_numbers       jsonb,  -- { "UA": "...", "AA": "...", ... }
  preferred_hotel_chains       text[] not null default '{}',

  -- Budget — coarse tier; agents can use it as a soft default when user
  -- hasn't specified a price ceiling on a turn.
  budget_tier                  text,   -- "budget" | "standard" | "premium"

  -- Payment hint — we never store raw card numbers here. This is a
  -- human-readable label like "Chase Sapphire •• 4242" or an agent-scoped
  -- alias. The actual PCI-compliant token lives with Stripe/Food Agent.
  preferred_payment_hint       text,

  -- Opaque scratchpad for fields we don't have explicit columns for yet.
  -- Gives Claude room to stash structured extras without schema churn.
  extra                        jsonb not null default '{}'::jsonb,

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

drop trigger if exists user_profile_touch_updated_at on public.user_profile;
create trigger user_profile_touch_updated_at
  before update on public.user_profile
  for each row execute function public.tg_touch_updated_at();

-- Auto-provision an empty user_profile row when a new profiles row lands
-- (which happens via auth.users trigger from migration 004). Saves every
-- read path from having to handle "row might not exist yet" — they can
-- just select and trust.
create or replace function public.tg_handle_new_profile()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_profile (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created on public.profiles;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.tg_handle_new_profile();

-- Backfill for existing rows (safe to re-run).
insert into public.user_profile (id)
  select p.id from public.profiles p
  left join public.user_profile up on up.id = p.id
  where up.id is null;

-- ────────────────────────────────────────────────────────────────────
-- user_facts — free-text memories with embeddings
-- ────────────────────────────────────────────────────────────────────
-- Append-mostly. Claude emits memory_save tool calls during conversation;
-- each one becomes a row here. Retrieval is:
--
--   select ... where user_id = $1 and deleted_at is null
--   order by
--     (embedding <=> $query_embedding) * 0.8 +        -- semantic
--     (1 - exp(-extract(epoch from (now() - last_confirmed_at)) / 604800.0)) * 0.2
--     -- recency: 7-day half-life
--   limit 8
--
-- Facts are categorized so the UI can group them. `supersedes_id` lets a
-- new fact explicitly replace an older one (e.g., the user moved houses,
-- the new home_address fact replaces the old one — but we keep the
-- history).
--
-- Soft-delete via deleted_at rather than DELETE so "forget that" is
-- reversible for a grace period and so audit is preserved.
create table if not exists public.user_facts (
  id                     text primary key,
  user_id                uuid not null references public.profiles(id) on delete cascade,

  fact                   text not null check (char_length(fact) between 3 and 2000),
  category               text not null check (category in (
                           'preference',    -- likes/dislikes
                           'identity',      -- names, roles, relationships
                           'habit',         -- recurring patterns user self-describes
                           'location',      -- home/work/favorites
                           'constraint',    -- dietary, allergy, accessibility
                           'context',       -- short-lived: "traveling this week"
                           'milestone',     -- "birthday is May 12", "anniversary is 8/3"
                           'other'
                         )),

  -- Provenance so the UI can say "Lumo learned this from a conversation"
  -- vs. "You told Lumo directly" vs. "Inferred from your orders".
  source                 text not null check (source in (
                           'explicit',       -- user literally said it
                           'inferred',       -- Claude concluded it from context
                           'behavioral'      -- derived from events/history
                         )) default 'explicit',

  confidence             real not null default 1.0 check (confidence between 0 and 1),

  -- 1536-dim vector for OpenAI text-embedding-3-small. Nullable: when
  -- OPENAI_API_KEY isn't configured, we still store the fact but skip
  -- the embedding; retrieval falls back to recency + keyword.
  embedding              vector(1536),

  supersedes_id          text references public.user_facts(id) on delete set null,

  first_seen_at          timestamptz not null default now(),
  last_confirmed_at      timestamptz not null default now(),
  deleted_at             timestamptz,
  updated_at             timestamptz not null default now()
);

drop trigger if exists user_facts_touch_updated_at on public.user_facts;
create trigger user_facts_touch_updated_at
  before update on public.user_facts
  for each row execute function public.tg_touch_updated_at();

-- List-facts-for-user hot path. Partial on deleted_at is null so the
-- index stays small as soft-deletes accumulate.
create index if not exists user_facts_live_by_user
  on public.user_facts (user_id, last_confirmed_at desc)
  where deleted_at is null;

-- Vector ANN index. IVFFlat is good enough for sub-100k rows per user
-- (we're nowhere near that). cosine distance matches the retrieval
-- scoring above.
create index if not exists user_facts_embedding_cosine
  on public.user_facts using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Category filter for the /memory UI grouping.
create index if not exists user_facts_by_user_category
  on public.user_facts (user_id, category)
  where deleted_at is null;

-- ────────────────────────────────────────────────────────────────────
-- user_behavior_patterns — aggregated signals from events
-- ────────────────────────────────────────────────────────────────────
-- Not populated by this migration. A nightly job (coming in J3) will
-- read events + trips, detect recurring patterns, and upsert rows here.
-- Example rows:
--   { pattern_kind: 'day_of_week',     description: 'Orders food on Fri evenings', evidence_count: 11 }
--   { pattern_kind: 'frequent_route',  description: 'NYC ↔ LAX monthly',           evidence_count: 8 }
--   { pattern_kind: 'cuisine',         description: 'Prefers Thai + Japanese',     evidence_count: 17 }
--
-- The orchestrator reads high-confidence patterns (confidence >= 0.7)
-- and folds them into the system prompt alongside user_facts.
create table if not exists public.user_behavior_patterns (
  id                  text primary key,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  pattern_kind        text not null check (pattern_kind in (
                        'day_of_week',
                        'time_of_day',
                        'frequent_route',
                        'frequent_destination',
                        'recurring_order',
                        'cuisine',
                        'budget_range',
                        'companion'
                      )),
  description         text not null,
  evidence_count      int not null default 0 check (evidence_count >= 0),
  confidence          real not null default 0 check (confidence between 0 and 1),
  first_observed_at   timestamptz not null default now(),
  last_observed_at    timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists user_behavior_patterns_touch_updated_at on public.user_behavior_patterns;
create trigger user_behavior_patterns_touch_updated_at
  before update on public.user_behavior_patterns
  for each row execute function public.tg_touch_updated_at();

create index if not exists user_behavior_patterns_by_user
  on public.user_behavior_patterns (user_id, confidence desc);

-- ────────────────────────────────────────────────────────────────────
-- Hard-delete helper — "forget everything Lumo knows about me"
-- ────────────────────────────────────────────────────────────────────
-- Callable from a /memory settings action. Keeps the profiles row (so
-- auth still works) but nukes learned context. Agent_connections and
-- trip history are NOT touched here — those have their own controls
-- (disconnect, trip cancel).
create or replace function public.forget_everything(target_user uuid)
returns void language plpgsql security definer as $$
begin
  -- Hard-delete facts (not soft) — this is the explicit user command.
  delete from public.user_facts where user_id = target_user;
  delete from public.user_behavior_patterns where user_id = target_user;
  -- Reset profile to empty shell but keep the row (FK target).
  update public.user_profile set
    display_name = null, timezone = null, preferred_language = null,
    home_address = null, work_address = null,
    dietary_flags = '{}', allergies = '{}', preferred_cuisines = '{}',
    preferred_airline_class = null, preferred_airline_seat = null,
    frequent_flyer_numbers = null, preferred_hotel_chains = '{}',
    budget_tier = null, preferred_payment_hint = null,
    extra = '{}'::jsonb
  where id = target_user;
end;
$$;
