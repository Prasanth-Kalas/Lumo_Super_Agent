-- Migration 066 — capability tiers for partner developers.
--
-- New partners default to tier_1: their agents can only expose tools
-- with cost_tier `free` or `low` (read-only-ish — lookups, queries,
-- no real side effects). Admins promote a developer up after the
-- partner has shown clean operation:
--
--   tier_1  free, low                — read-only baseline
--   tier_2  free, low, metered       — write / state-changing tools
--   tier_3  free, low, metered, money — payment / booking tools
--
-- Rationale: today an admin approves a developer and the partner
-- can immediately ship money tools. That's a big trust step on
-- day-one. Tiers split it: prove safe behavior with tier_1 first,
-- earn metered + money over time. v1 is admin-driven; v2 can
-- automate promotion based on incident-free invocation count.
--
-- Lumo's env-allowlist publishers (LUMO_PUBLISHER_EMAILS) are
-- treated as tier_3 in code regardless of any DB row, so this
-- column doesn't gate the Lumo team. System agents from
-- config/agents.registry.json bypass entirely (separate code
-- path that doesn't touch partner_developers).
--
-- We also add a functional index on
-- partner_agents (parsed_manifest->>'agent_id') so the router can
-- map agent_id → publisher_email → tier in one indexed lookup
-- per dispatch (the JSONB extraction is otherwise a seq scan).

alter table partner_developers
  add column if not exists capability_tier text not null default 'tier_1'
    check (capability_tier in ('tier_1', 'tier_2', 'tier_3'));

comment on column partner_developers.capability_tier is
  'Trust tier gating which tool cost_tiers this developer''s agents can expose. tier_1 (default): free + low. tier_2: + metered. tier_3: + money.';

-- Functional index: partner_agents.parsed_manifest is JSONB, and
-- the agent_id is stored inside it (not a separate column). The
-- runtime gate joins this table on agent_id, so a btree on the
-- extracted text turns the lookup from O(n) into O(log n). The
-- predicate matches the runtime query (only published rows are
-- ever served) so the index is small.
create index if not exists partner_agents_agent_id_published_idx
  on partner_agents ((parsed_manifest->>'agent_id'))
  where is_published;
