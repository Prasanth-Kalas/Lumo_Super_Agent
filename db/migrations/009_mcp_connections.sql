-- Migration 009 — per-user MCP server connections.
--
-- Phase 1 of external-agents stores bearer tokens directly. This is
-- deliberately simpler than the OAuth flow in user_agent_connections
-- (migration 004) because most useful MCP servers today are either
-- public (no auth) or accept a long-lived bearer token the user
-- generated themselves (Google Cloud API key, Slack xoxb, etc.).
--
-- Phase 2 will add an OAuth path for MCP servers that implement the
-- spec's 2.1 flow. At that point this table grows refresh_token and
-- expires_at, mirroring the fields already present on
-- user_agent_connections. For now, keep it small.
--
-- Security:
--   - access_token is stored in plaintext today. Apply pgcrypto
--     column encryption in a follow-up migration once the column is
--     in use by real users; bolting it on now while the table is
--     empty is simpler than migrating live secrets later.
--   - RLS: users can only read their own rows. Same pattern the
--     rest of the per-user tables use.

create table if not exists user_mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Slug matches config/mcp-servers.json :: server_id. Not a FK
  -- because the catalog is file-based, not a DB table.
  server_id text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  access_token text,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, server_id)
);

create index if not exists user_mcp_connections_user_active_idx
  on user_mcp_connections (user_id)
  where status = 'active';

alter table user_mcp_connections enable row level security;

-- Users can read their own connections (needed by the /memory page
-- and the client-side "already connected?" checks).
drop policy if exists user_mcp_connections_self_read on user_mcp_connections;
create policy user_mcp_connections_self_read
  on user_mcp_connections
  for select
  using (auth.uid() = user_id);

-- Users can insert a connection for themselves. Server-side routes
-- that run with the service-role key bypass this anyway; the policy
-- is belt-and-suspenders for any future anon-key client paths.
drop policy if exists user_mcp_connections_self_insert on user_mcp_connections;
create policy user_mcp_connections_self_insert
  on user_mcp_connections
  for insert
  with check (auth.uid() = user_id);

-- Users can update their own (mark revoked, rotate token).
drop policy if exists user_mcp_connections_self_update on user_mcp_connections;
create policy user_mcp_connections_self_update
  on user_mcp_connections
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Users can delete their own (cascades to revoke everywhere).
drop policy if exists user_mcp_connections_self_delete on user_mcp_connections;
create policy user_mcp_connections_self_delete
  on user_mcp_connections
  for delete
  using (auth.uid() = user_id);
