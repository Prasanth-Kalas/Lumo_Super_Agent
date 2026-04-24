/**
 * Agent-connections DAO.
 *
 * One row per active OAuth grant a Lumo user has issued to a downstream
 * agent. Tokens are encrypted at rest via lib/crypto.ts; this module is
 * the ONLY place in the codebase that decrypts them, and it only hands
 * out plaintext in a tightly-scoped return value. Callers that don't
 * need the secret (the marketplace, the /connections list UI) get the
 * metadata-only projection via `listConnectionsForUser`.
 *
 * Token refresh: when the router finds an active connection whose
 * `expires_at` is in the past (or within REFRESH_SKEW_MS), it calls
 * `refreshAccessToken()` which hits the agent's token_url with the
 * refresh_token and rewraps the result. On failure we mark the row
 * `expired` and the router surfaces that as a `connection_required`
 * error to the orchestrator, which in turn tells the user to reconnect.
 */

import type { AgentConnectOAuth2 } from "@lumo/agent-sdk";
import { getSupabase } from "./db.js";
import { open, seal, mintConnectionId, type SealedSecret } from "./crypto.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type ConnectionStatus = "active" | "expired" | "revoked" | "error";

export interface ConnectionMeta {
  id: string;
  user_id: string;
  agent_id: string;
  status: ConnectionStatus;
  scopes: string[];
  expires_at: string | null;
  provider_account_id: string | null;
  connected_at: string;
  last_refreshed_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  updated_at: string;
}

/** A connection WITH decrypted tokens. Hand this out sparingly. */
export interface DecryptedConnection extends ConnectionMeta {
  access_token: string;
  refresh_token: string | null;
}

export interface TokenMaterial {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number | null;
  scope?: string | null;
  provider_account_id?: string | null;
}

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  constructor(code: ConnectionErrorCode, message: string) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
  }
}
export type ConnectionErrorCode =
  | "persistence_disabled"
  | "not_connected"
  | "refresh_failed"
  | "not_refreshable"
  | "agent_config_missing";

// How many seconds before expiry we pre-emptively refresh. 60s gives us
// comfortable headroom against clock skew and the latency of the token
// round-trip itself.
const REFRESH_SKEW_SEC = 60;

// ──────────────────────────────────────────────────────────────────────────
// Mutations
// ──────────────────────────────────────────────────────────────────────────

/**
 * Persist tokens returned from an agent's token endpoint. Called by the
 * /api/connections/callback route after a successful code exchange.
 *
 * If an ACTIVE row already exists for (user_id, agent_id), we revoke it
 * first (status → revoked) and insert a fresh one. That keeps the
 * "one active per (user, agent)" invariant enforced by the partial
 * unique index, while preserving the history row for audit.
 */
export async function saveConnection(args: {
  user_id: string;
  agent_id: string;
  tokens: TokenMaterial;
  scopes_granted: string[];
}): Promise<ConnectionMeta> {
  const db = getSupabase();
  if (!db) {
    throw new ConnectionError(
      "persistence_disabled",
      "Connections require Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  // Revoke any existing active connection. We do this as a plain update
  // rather than relying on the unique index to surface a conflict because
  // the caller's UX intent is "replace it" and the SQL expresses that
  // better than a catch-and-retry.
  await db
    .from("agent_connections")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("user_id", args.user_id)
    .eq("agent_id", args.agent_id)
    .eq("status", "active");

  const id = mintConnectionId();
  const accessSealed = seal(args.tokens.access_token);
  const refreshSealed = args.tokens.refresh_token
    ? seal(args.tokens.refresh_token)
    : null;

  const expires_at = args.tokens.expires_in
    ? new Date(Date.now() + args.tokens.expires_in * 1000).toISOString()
    : null;

  // The Supabase JS client encodes bytea inputs based on JSON.stringify.
  // A Node Buffer serializes as `{ "type": "Buffer", "data": [...] }`
  // which the PostgREST encoder then writes as JSON into a bytea column —
  // which is NOT what we want. Routing through `bufferToPgEscape()` emits
  // the PostgreSQL BYTEA hex-escape literal `\x…` that the Supabase client
  // forwards verbatim. That round-trips cleanly back to a Uint8Array on
  // select (see openTokenColumn → toSealed in this file).
  const row = {
    id,
    user_id: args.user_id,
    agent_id: args.agent_id,
    status: "active" as const,
    access_token_ciphertext: bufferToPgEscape(accessSealed.ciphertext),
    access_token_iv: bufferToPgEscape(accessSealed.iv),
    access_token_tag: bufferToPgEscape(accessSealed.tag),
    refresh_token_ciphertext: refreshSealed
      ? bufferToPgEscape(refreshSealed.ciphertext)
      : null,
    refresh_token_iv: refreshSealed ? bufferToPgEscape(refreshSealed.iv) : null,
    refresh_token_tag: refreshSealed ? bufferToPgEscape(refreshSealed.tag) : null,
    expires_at,
    scopes: args.scopes_granted,
    provider_account_id: args.tokens.provider_account_id ?? null,
    connected_at: new Date().toISOString(),
    last_refreshed_at: null,
    last_used_at: null,
    revoked_at: null,
  };

  const { data, error } = await db
    .from("agent_connections")
    .insert(row)
    .select(
      "id, user_id, agent_id, status, scopes, expires_at, provider_account_id, connected_at, last_refreshed_at, last_used_at, revoked_at, updated_at",
    )
    .single();

  if (error || !data) {
    throw new ConnectionError(
      "refresh_failed",
      `Failed to persist connection: ${error?.message ?? "unknown"}`,
    );
  }

  return toConnectionMeta(data);
}

/**
 * Mark an active connection as revoked. Caller SHOULD also hit the
 * agent's revocation_url (if declared) — this module doesn't do the
 * network call because we don't want to retry a 500 from the agent
 * while holding a DB connection.
 */
export async function revokeConnection(
  user_id: string,
  connection_id: string,
): Promise<void> {
  const db = getSupabase();
  if (!db) throw new ConnectionError("persistence_disabled", "Supabase not configured.");

  const { error } = await db
    .from("agent_connections")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", connection_id)
    .eq("user_id", user_id)
    .eq("status", "active");

  if (error) {
    throw new ConnectionError("refresh_failed", `Revoke failed: ${error.message}`);
  }
}

/**
 * Bump last_used_at so the UI can show "Last used 5 minutes ago" on the
 * /connections page. Fire-and-forget from the router's hot path.
 */
export async function touchLastUsed(connection_id: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db
    .from("agent_connections")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", connection_id);
}

// ──────────────────────────────────────────────────────────────────────────
// Reads
// ──────────────────────────────────────────────────────────────────────────

/**
 * Metadata-only list of a user's connections (active + recent history).
 * Used by the /connections UI and the marketplace to render Connect vs.
 * Connected badges.
 */
export async function listConnectionsForUser(
  user_id: string,
): Promise<ConnectionMeta[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("agent_connections")
    .select(
      "id, user_id, agent_id, status, scopes, expires_at, provider_account_id, connected_at, last_refreshed_at, last_used_at, revoked_at, updated_at",
    )
    .eq("user_id", user_id)
    .order("updated_at", { ascending: false });
  if (error) {
    console.error("[connections] listConnectionsForUser failed:", error.message);
    return [];
  }
  return (data ?? []).map(toConnectionMeta);
}

/**
 * Active connection lookup for the router's hot path. Decrypts tokens
 * and auto-refreshes if we're within REFRESH_SKEW_SEC of expiry.
 *
 * Returns null if no active connection exists. Throws ConnectionError
 * on persistence/refresh failures the caller needs to surface.
 */
export async function getDispatchableConnection(args: {
  user_id: string;
  agent_id: string;
  oauth2_config: AgentConnectOAuth2;
}): Promise<DecryptedConnection | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data, error } = await db
    .from("agent_connections")
    .select("*")
    .eq("user_id", args.user_id)
    .eq("agent_id", args.agent_id)
    .eq("status", "active")
    .limit(1);

  if (error) {
    console.error("[connections] getDispatchableConnection read failed:", error.message);
    return null;
  }

  const row = data?.[0];
  if (!row) return null;

  const access = openTokenColumn(row, "access_token");
  const refresh = row.refresh_token_ciphertext
    ? openTokenColumn(row, "refresh_token")
    : null;

  const expires_at = row.expires_at ? new Date(row.expires_at) : null;
  const now = new Date();
  const needsRefresh =
    expires_at !== null &&
    expires_at.getTime() - now.getTime() < REFRESH_SKEW_SEC * 1000;

  if (!needsRefresh) {
    return {
      ...toConnectionMeta(row),
      access_token: access,
      refresh_token: refresh,
    };
  }

  if (!refresh) {
    await markExpired(row.id);
    return null;
  }

  // Refresh inline. If it fails we mark expired and return null so the
  // router surfaces `connection_required`.
  try {
    const fresh = await refreshAccessToken({
      refresh_token: refresh,
      oauth2_config: args.oauth2_config,
    });
    const updated = await rewrapTokens(row.id, fresh);
    return {
      ...toConnectionMeta(updated),
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token ?? refresh,
    };
  } catch (err) {
    console.warn(
      `[connections] refresh failed for conn=${row.id} agent=${args.agent_id}:`,
      err instanceof Error ? err.message : err,
    );
    await markExpired(row.id);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// OAuth state store (PKCE round-trip)
// ──────────────────────────────────────────────────────────────────────────

export interface OAuthStateRow {
  state: string;
  user_id: string;
  agent_id: string;
  code_verifier: string;
  redirect_after: string | null;
  expires_at: string;
}

export async function saveOAuthState(row: OAuthStateRow): Promise<void> {
  const db = getSupabase();
  if (!db) throw new ConnectionError("persistence_disabled", "Supabase not configured.");
  // Opportunistic sweep so the table doesn't grow unbounded on a
  // zero-cron deployment.
  await db.rpc("sweep_expired_oauth_states");
  const { error } = await db.from("oauth_states").insert({
    state: row.state,
    user_id: row.user_id,
    agent_id: row.agent_id,
    code_verifier: row.code_verifier,
    redirect_after: row.redirect_after,
    expires_at: row.expires_at,
  });
  if (error) {
    throw new ConnectionError("refresh_failed", `saveOAuthState: ${error.message}`);
  }
}

/**
 * Consume a state row — returns it if valid & unused, deletes it so it
 * can't be replayed. Enforces not-expired.
 */
export async function consumeOAuthState(
  state: string,
): Promise<OAuthStateRow | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("oauth_states")
    .select("*")
    .eq("state", state)
    .limit(1);
  if (error || !data?.[0]) return null;

  const row = data[0] as OAuthStateRow;
  // Delete first so a racing second callback can't consume the same row.
  const { error: delErr } = await db
    .from("oauth_states")
    .delete()
    .eq("state", state);
  if (delErr) {
    console.warn("[connections] consumeOAuthState delete warn:", delErr.message);
  }

  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

interface RowFromDb {
  id: string;
  user_id: string;
  agent_id: string;
  status: ConnectionStatus;
  access_token_ciphertext?: Buffer | Uint8Array | string;
  access_token_iv?: Buffer | Uint8Array | string;
  access_token_tag?: Buffer | Uint8Array | string;
  refresh_token_ciphertext?: Buffer | Uint8Array | string | null;
  refresh_token_iv?: Buffer | Uint8Array | string | null;
  refresh_token_tag?: Buffer | Uint8Array | string | null;
  scopes: string[] | unknown;
  expires_at: string | null;
  provider_account_id: string | null;
  connected_at: string;
  last_refreshed_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  updated_at: string;
}

function toConnectionMeta(row: RowFromDb): ConnectionMeta {
  return {
    id: row.id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    status: row.status,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    expires_at: row.expires_at,
    provider_account_id: row.provider_account_id,
    connected_at: row.connected_at,
    last_refreshed_at: row.last_refreshed_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    updated_at: row.updated_at,
  };
}

function openTokenColumn(row: RowFromDb, which: "access_token" | "refresh_token"): string {
  const ct = which === "access_token" ? row.access_token_ciphertext : row.refresh_token_ciphertext;
  const iv = which === "access_token" ? row.access_token_iv : row.refresh_token_iv;
  const tag = which === "access_token" ? row.access_token_tag : row.refresh_token_tag;
  if (!ct || !iv || !tag) {
    throw new ConnectionError(
      "not_connected",
      `Row is missing ${which} ciphertext components.`,
    );
  }
  return open(toSealed(ct, iv, tag));
}

function toSealed(
  ct: Buffer | Uint8Array | string,
  iv: Buffer | Uint8Array | string,
  tag: Buffer | Uint8Array | string,
): SealedSecret {
  return {
    ciphertext: coerceBytes(ct),
    iv: coerceBytes(iv),
    tag: coerceBytes(tag),
  };
}

/**
 * PostgreSQL bytea hex-escape format: `\x<hex>`. The Supabase JS client
 * forwards this verbatim to PostgREST, which stores it as bytea. On
 * select, PostgREST returns bytea values as the same hex-escape string,
 * which we decode via `coerceBytes` below. Buffers are NOT sent as JSON
 * arrays or base64 — always the hex-escape.
 */
function bufferToPgEscape(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}

/**
 * Accept whatever shape Supabase hands back for a bytea column (string
 * hex-escape is the common case; Buffer/Uint8Array are defensive paths
 * in case the client or a future PostgREST update changes behavior) and
 * normalize to Buffer.
 */
function coerceBytes(v: Buffer | Uint8Array | string): Buffer {
  if (typeof v === "string") {
    // PostgREST serializes bytea as the JSON string "\\x<hex>", which
    // JSON.parse decodes to the two-char prefix backslash+x followed by
    // hex digits. Strip that prefix if present; otherwise assume the
    // caller handed us a raw hex string.
    const hex = v.startsWith("\\x") ? v.slice(2) : v;
    return Buffer.from(hex, "hex");
  }
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

async function markExpired(connection_id: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db
    .from("agent_connections")
    .update({ status: "expired" })
    .eq("id", connection_id);
}

async function rewrapTokens(
  connection_id: string,
  tokens: TokenMaterial,
): Promise<RowFromDb> {
  const db = getSupabase();
  if (!db) throw new ConnectionError("persistence_disabled", "Supabase not configured.");

  const accessSealed = seal(tokens.access_token);
  const refreshSealed = tokens.refresh_token ? seal(tokens.refresh_token) : null;
  const expires_at = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const patch: Record<string, unknown> = {
    access_token_ciphertext: bufferToPgEscape(accessSealed.ciphertext),
    access_token_iv: bufferToPgEscape(accessSealed.iv),
    access_token_tag: bufferToPgEscape(accessSealed.tag),
    expires_at,
    last_refreshed_at: new Date().toISOString(),
  };
  if (refreshSealed) {
    patch.refresh_token_ciphertext = bufferToPgEscape(refreshSealed.ciphertext);
    patch.refresh_token_iv = bufferToPgEscape(refreshSealed.iv);
    patch.refresh_token_tag = bufferToPgEscape(refreshSealed.tag);
  }

  const { data, error } = await db
    .from("agent_connections")
    .update(patch)
    .eq("id", connection_id)
    .select("*")
    .single();

  if (error || !data) {
    throw new ConnectionError("refresh_failed", `rewrapTokens: ${error?.message ?? "unknown"}`);
  }
  return data as RowFromDb;
}

/**
 * Exchange a refresh token for a fresh access token via the agent's
 * token endpoint. RFC 6749 §6 — grant_type=refresh_token.
 *
 * The agent MUST respond with 200 + JSON body:
 *   { access_token, token_type: "Bearer", expires_in?, refresh_token?, scope? }
 *
 * Some agents rotate refresh tokens (return a new one); others don't. If
 * they don't, we keep using the old one. If they do and this call fails
 * mid-flight, the user has to reconnect — acceptable edge case for MVP.
 */
async function refreshAccessToken(args: {
  refresh_token: string;
  oauth2_config: AgentConnectOAuth2;
}): Promise<TokenMaterial> {
  const { oauth2_config, refresh_token } = args;

  const clientId = process.env[oauth2_config.client_id_env];
  const clientSecret = oauth2_config.client_secret_env
    ? process.env[oauth2_config.client_secret_env]
    : undefined;

  if (!clientId) {
    throw new ConnectionError(
      "agent_config_missing",
      `Env ${oauth2_config.client_id_env} is not set.`,
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
    client_id: clientId,
  });
  if (clientSecret && oauth2_config.client_type === "confidential") {
    body.set("client_secret", clientSecret);
  }

  const res = await fetch(oauth2_config.token_url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ConnectionError(
      "refresh_failed",
      `Token endpoint returned ${res.status}: ${text.slice(0, 240)}`,
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!json.access_token) {
    throw new ConnectionError("refresh_failed", "Token response missing access_token.");
  }
  if (json.token_type && json.token_type.toLowerCase() !== "bearer") {
    throw new ConnectionError(
      "refresh_failed",
      `Unsupported token_type ${json.token_type}; expected Bearer.`,
    );
  }

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? null,
    expires_in: json.expires_in ?? null,
    scope: json.scope ?? null,
  };
}

/**
 * Perform the initial code-for-tokens exchange. Called by
 * /api/connections/callback. Shares most of its shape with
 * refreshAccessToken() but deliberately kept separate — the grant_type
 * differs, the PKCE verifier is carried here and not on refresh, and
 * the two have different failure-mode UX.
 */
export async function exchangeAuthorizationCode(args: {
  code: string;
  code_verifier: string;
  redirect_uri: string;
  oauth2_config: AgentConnectOAuth2;
}): Promise<TokenMaterial> {
  const { oauth2_config, code, code_verifier, redirect_uri } = args;

  const clientId = process.env[oauth2_config.client_id_env];
  const clientSecret = oauth2_config.client_secret_env
    ? process.env[oauth2_config.client_secret_env]
    : undefined;

  if (!clientId) {
    throw new ConnectionError(
      "agent_config_missing",
      `Env ${oauth2_config.client_id_env} is not set.`,
    );
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier,
    redirect_uri,
    client_id: clientId,
  });
  if (clientSecret && oauth2_config.client_type === "confidential") {
    body.set("client_secret", clientSecret);
  }

  const res = await fetch(oauth2_config.token_url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ConnectionError(
      "refresh_failed",
      `Token endpoint returned ${res.status}: ${text.slice(0, 240)}`,
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    provider_account_id?: string;
  };

  if (!json.access_token) {
    throw new ConnectionError("refresh_failed", "Token response missing access_token.");
  }

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? null,
    expires_in: json.expires_in ?? null,
    scope: json.scope ?? null,
    provider_account_id: json.provider_account_id ?? null,
  };
}
