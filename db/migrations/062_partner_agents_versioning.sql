-- Migration 062 — partner_agents versioning + publish pointer.
--
-- Mental model: Lumo marketplace ≈ Apple App Store. We don't host the
-- agent's code; we host the certified manifest + a "currently
-- published" pointer. Each (publisher_email, manifest_url, version)
-- triple is an immutable, separately-reviewable artifact (like an
-- App Store binary). At any moment exactly one approved version per
-- (publisher_email, manifest_url) is `is_published=true` — that's
-- what the orchestrator's bridge serves to users. Promotion =
-- flipping the pointer; rollback = flipping it back. Partners can
-- have v0.2 and v0.3 both `approved` simultaneously (one in flight
-- review, the prior live one) — only the published row is exposed
-- to Claude.
--
-- Why a partial unique index instead of `is_published+manifest_url`
-- in a regular UNIQUE: Postgres lets multiple rows have
-- `is_published=false` for the same (email, url), but enforces
-- uniqueness only when the predicate matches. Standard pattern for
-- "exactly one current row per group."
--
-- Backfill: existing rows pre-date the version column. We extract
-- `parsed_manifest->>'version'` and fall back to '0.0.0-legacy' if
-- the manifest payload is missing/corrupt — keeps the NOT NULL
-- constraint satisfied without dropping data. Approved legacy rows
-- are auto-promoted to `is_published=true` so the orchestrator
-- doesn't lose them on the next boot. The pre-existing
-- (publisher_email, manifest_url) unique constraint guarantees at
-- most one approved row per pair, so the auto-promotion is
-- unambiguous.

-- 1. Add the columns. Nullable initially so backfill can populate.
alter table partner_agents
  add column if not exists version text;

alter table partner_agents
  add column if not exists is_published boolean not null default false;

-- 2. Backfill version from the parsed manifest. The SDK's manifest
-- schema requires a strict semver `version` field, so this should
-- hit the happy path for every certified row. Failed/pending rows
-- without a parsed manifest fall through to the legacy sentinel.
update partner_agents
set version = coalesce(parsed_manifest->>'version', '0.0.0-legacy')
where version is null;

-- 3. Promote the existing approved row (if any) to is_published.
-- Pre-migration the unique constraint guaranteed one per (email,
-- url), so this never sets two rows true for the same pair.
update partner_agents
set is_published = true
where status = 'approved'
  and is_published = false;

-- 4. Lock down the version column.
alter table partner_agents
  alter column version set not null;

-- 5. Swap the uniqueness story.
alter table partner_agents
  drop constraint if exists partner_agents_publisher_email_manifest_url_key;

-- One row per (email, url, version) — partner can only resubmit the
-- same version's manifest URL once. New version = new row.
alter table partner_agents
  add constraint partner_agents_publisher_email_manifest_url_version_key
  unique (publisher_email, manifest_url, version);

-- At most one published row per (email, url). Partial index so
-- the constraint only applies when is_published is true; multiple
-- not-yet-published rows can coexist.
create unique index if not exists partner_agents_one_published_per_url_idx
  on partner_agents (publisher_email, manifest_url)
  where is_published;

-- 6. Loader-friendly index. The orchestrator queries `WHERE status =
-- 'approved' AND is_published = true` on every boot; this makes the
-- bridge build O(published rows) instead of O(all rows).
create index if not exists partner_agents_published_lookup_idx
  on partner_agents (status, is_published)
  where status = 'approved' and is_published;

-- 7. Comment the columns so future readers don't have to grep this
-- file to understand the App Store framing.
comment on column partner_agents.version is
  'Semver from manifest.version. Immutable per row; new manifest version = new row.';
comment on column partner_agents.is_published is
  'True for the one approved row currently served to users (the App Store equivalent of "current version on the store"). Promotion/rollback flips this between rows.';
