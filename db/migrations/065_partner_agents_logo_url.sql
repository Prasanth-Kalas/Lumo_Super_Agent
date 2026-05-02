-- Migration 065 — agent-level logo URL (App Store icon equivalent).
--
-- The marketplace today renders default colored letter avatars per
-- agent_id (the "G" / "M" tiles you see on /marketplace). Partners
-- want their brand on their card. This adds a free-form
-- `logo_url text` column on partner_agents so each (publisher_email,
-- manifest_url, version) row can carry its own logo — a new version
-- can refresh the brand without an admin touching anything outside
-- the existing version-promotion flow from migration 062.
--
-- v1: URL-only. The publisher portal accepts a string (their own
--     CDN, the manifest's declared url, etc.). Lumo doesn't host
--     uploads yet.
-- v2: Supabase Storage upload pipeline. When that lands, this
--     column still holds the resolved URL — the upload helper just
--     produces it instead of the developer pasting it.
--
-- The column is nullable because:
--  - Existing rows have no logo (they'll fall back to the colored-
--    letter avatar).
--  - System / first-party agents from config/agents.registry.json
--    still come from the manifest object directly; this column
--    only applies to partner-submitted rows.
--
-- A loose CHECK enforces "looks like an http(s) URL or null" so
-- typos don't silently render broken <img> tags. We don't validate
-- length / aspect ratio / MIME server-side — that's a downstream
-- decision (the marketplace UI can box-fit any image).

alter table partner_agents
  add column if not exists logo_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'partner_agents_logo_url_shape'
  ) then
    alter table partner_agents
      add constraint partner_agents_logo_url_shape
      check (logo_url is null or logo_url ~ '^https?://');
  end if;
end$$;

comment on column partner_agents.logo_url is
  'Optional brand logo for this agent version. URL-only in v1 (partner hosts on their CDN). Nullable; falls back to the colored-letter avatar when absent.';
