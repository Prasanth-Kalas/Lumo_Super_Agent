-- Migration 064 — partner developer accounts (self-serve onboarding).
--
-- Until now, publishing access was an env-var allowlist
-- (LUMO_PUBLISHER_EMAILS). Anyone outside that list got a "not
-- invited" notice with no path to opt in. This table is the
-- self-serve mechanism: anyone can submit a developer application,
-- the request lands in `tier = 'waitlisted'`, and an admin
-- approves it from /admin/review-queue. The env allowlist still
-- wins for the Lumo team itself, so no admin step is needed for
-- internal accounts.
--
-- Tier semantics:
--
--   waitlisted  → application submitted, awaiting admin review.
--                 Cannot submit agents yet.
--   approved    → admin cleared. Same access as an env-allowlist
--                 publisher.
--   rejected    → admin declined. Reason in reviewer_note.
--   revoked     → previously approved; pulled post-hoc (security
--                 incident, partnership terminated, etc.). Cannot
--                 submit; existing approved submissions stay
--                 published unless separately revoked at the
--                 partner_agents level.
--
-- Email is the primary key. Lowercased on insert (the same
-- convention the access checks already use). One application per
-- email — re-applying after rejection means an admin updates the
-- existing row's tier back to waitlisted.

create table if not exists partner_developers (
  email           text primary key,
  display_name    text,
  company         text,
  -- Free-form pitch from the applicant. Helps admins decide.
  reason          text,
  tier            text not null default 'waitlisted'
    check (tier in ('waitlisted', 'approved', 'rejected', 'revoked')),
  reviewer_note   text,
  reviewed_at     timestamptz,
  reviewed_by     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Admin queue scans by tier first (waitlisted at the top), then by
-- recency. This index keeps that ordering cheap as the table grows.
create index if not exists partner_developers_tier_created_idx
  on partner_developers (tier, created_at desc);

-- RLS: a developer can read their own row to see their tier.
-- Admin writes go through the service role which bypasses RLS.
alter table partner_developers enable row level security;

drop policy if exists partner_developers_self_select on partner_developers;
create policy partner_developers_self_select
  on partner_developers
  for select
  using (
    email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

comment on table partner_developers is
  'Self-serve developer applications. tier=approved (or env LUMO_PUBLISHER_EMAILS) gates /publisher portal access. Lowercased email is the PK.';
