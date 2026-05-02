-- Migration 068 — make agent connections persist through transient
-- refresh failures.
--
-- Today: agent_connections.status flips from 'active' → 'expired'
-- on the FIRST refresh failure (lib/connections.ts:getDispatchable
-- Connection markExpired path). One network blip, one brief 401
-- from Google's OAuth endpoint, one expired refresh-token-scope
-- consent — and the row is silently dead. The orchestrator filters
-- by status='active', so the agent disappears from connectedAgentIds,
-- the system prompt tags it [NOT CONNECTED], and Claude tells the
-- user to "reconnect Google" even though they never disconnected.
--
-- Mental model: same as the App Store framing the rest of the
-- marketplace work uses. An iPhone app doesn't uninstall itself
-- when iCloud has a hiccup. A Lumo connection shouldn't either.
--
-- This migration adds two columns so the connection can carry
-- "transient failure" context without falling out of the active
-- set. The behavior change ships in lib/connections.ts:
--   - On refresh failure: bump refresh_failure_count, stamp
--     last_refresh_failed_at, leave status='active'. Return null
--     for THIS dispatch (router surfaces the failure cleanly).
--   - On refresh success: clear both fields back to 0/NULL.
--   - Status transitions to 'expired' or 'revoked' only on
--     explicit user action (revokeConnection) or when the failure
--     count crosses a sustained-outage threshold (left for a
--     follow-up — for now, "active forever unless user
--     disconnects" is the right default).

alter table agent_connections
  add column if not exists last_refresh_failed_at timestamptz;

alter table agent_connections
  add column if not exists refresh_failure_count integer not null default 0
    check (refresh_failure_count >= 0);

comment on column agent_connections.last_refresh_failed_at is
  'Wall-clock time of the most recent OAuth refresh-token failure. NULL means no failure since last successful refresh. Used by the UI to surface a Reconnect prompt without flipping status off active.';
comment on column agent_connections.refresh_failure_count is
  'Consecutive refresh-token failures since the last success. Resets to 0 on any successful refresh. Allows future heuristics (auto-flip-to-expired after N sustained failures) without re-shaping schema.';

-- One-time backfill: resurrect any rows that the prior auto-flip
-- killed, IF they still have a refresh token. The new
-- getDispatchableConnection will re-attempt the refresh on the
-- next dispatch; if the upstream provider has truly revoked the
-- grant, the row stays active but the failure counter starts
-- climbing and the call returns a clean "needs reconnect" via the
-- router. If the refresh works, the user never had to lift a
-- finger — which is the App-Store-like UX the rest of this
-- marketplace work is converging on.
--
-- Rows without a refresh_token_ciphertext stay in 'expired' — they
-- weren't recoverable before this migration and aren't now (the
-- user explicitly opted out of offline access at OAuth time).
update agent_connections
set status = 'active',
    refresh_failure_count = 0,
    last_refresh_failed_at = null,
    updated_at = now()
where status = 'expired'
  and refresh_token_ciphertext is not null;
