-- Migration 009 — per-user MCP server connections.
--
-- Phase 1 of external-agents stores bearer tokens in the same sealed
-- column shape as agent_connections (migration 004). Most useful MCP
-- servers today are either
-- public (no auth) or accept a long-lived bearer token the user
-- generated themselves (Google Cloud API key, Slack xoxb, etc.).
--
-- Phase 2 will add an OAuth path for MCP servers that implement the
-- spec's 2.1 flow. At that point this table grows refresh_token and
-- expires_at, mirroring the fields already present on
-- user_agent_connections. For now, keep it small.
--
-- Security:
--   - access_token is sealed in Node with AES-256-GCM via lib/crypto.ts.
--     The DB stores ciphertext, IV, and auth tag only.
--   - RLS: users can only read their own rows. Same pattern the
--     rest of the per-user tables use.

create table if not exists user_mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Slug matches config/mcp-servers.json :: server_id. Not a FK
  -- because the catalog is file-based, not a DB table.
  server_id text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  access_token_ciphertext bytea not null,
  access_token_iv bytea not null,
  access_token_tag bytea not null,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, server_id)
);

-- Retrofit early environments that created this table with a plaintext
-- access_token column. Existing plaintext tokens cannot be safely sealed
-- from SQL because AES-GCM sealing lives in Node, so revoke those rows
-- and require users to reconnect.
alter table user_mcp_connections
  add column if not exists access_token_ciphertext bytea;

alter table user_mcp_connections
  add column if not exists access_token_iv bytea;

alter table user_mcp_connections
  add column if not exists access_token_tag bytea;

update user_mcp_connections
set status = 'revoked'
where status = 'active'
  and (
    access_token_ciphertext is null
    or access_token_iv is null
    or access_token_tag is null
  );

alter table user_mcp_connections
  drop column if exists access_token;

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
