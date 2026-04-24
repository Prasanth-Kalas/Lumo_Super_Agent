-- Migration 010 — partner-submitted agents.
--
-- Publishers (vetted partners) submit their manifest URL through the
-- /publisher portal. An admin reviews it via /admin/review-queue and
-- either approves, rejects, or requests changes. Approved rows are
-- folded into the agent registry at startup alongside the static
-- config/agents.json — the registry loader treats both sources the
-- same.
--
-- Status machine:
--
--   pending   → just submitted. Server has validated the manifest
--               URL is reachable and the schema parses, but a human
--               hasn't blessed it yet.
--   approved  → an admin has cleared the submission. Registry loads
--               tools from this agent on every orchestrator turn.
--   rejected  → permanent. Reviewer note explains why. Publisher
--               must re-submit with a new row.
--   revoked   → previously approved, pulled post-hoc (security
--               concern, partner agreement ended). Preserves audit
--               trail vs. a hard delete.
--
-- Who can see what:
--   - The publisher (by email) sees their own submissions + status.
--   - Admins (identified by LUMO_ADMIN_EMAILS env) see everything.
--   - RLS enforces the publisher-side read. Admin reads bypass via
--     the service role key used by server routes.

create table if not exists partner_agents (
  id uuid primary key default gen_random_uuid(),

  publisher_email text not null,
  manifest_url text not null,
  -- Parsed AgentManifest at submit time, so we can render the
  -- submission detail page without re-fetching. Refreshed on every
  -- approve.
  parsed_manifest jsonb,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'revoked')),

  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  reviewer_note text,

  -- Attribution. Claude tool calls to this agent can be logged with
  -- this id so usage reports per publisher are trivial later.
  publisher_key text unique default encode(gen_random_bytes(24), 'hex'),

  unique (publisher_email, manifest_url)
);

create index if not exists partner_agents_status_idx
  on partner_agents (status)
  where status in ('pending', 'approved');

create index if not exists partner_agents_publisher_idx
  on partner_agents (publisher_email);

alter table partner_agents enable row level security;

-- Publisher can read their own submissions via the normal user
-- session (policy keys on the email stored in auth.users).
drop policy if exists partner_agents_publisher_read on partner_agents;
create policy partner_agents_publisher_read
  on partner_agents
  for select
  using (
    exists (
      select 1 from auth.users u
      where u.id = auth.uid() and u.email = partner_agents.publisher_email
    )
  );

-- Publisher can submit their own. Server routes validate the
-- manifest itself; RLS just enforces identity.
drop policy if exists partner_agents_publisher_insert on partner_agents;
create policy partner_agents_publisher_insert
  on partner_agents
  for insert
  with check (
    exists (
      select 1 from auth.users u
      where u.id = auth.uid() and u.email = partner_agents.publisher_email
    )
  );
