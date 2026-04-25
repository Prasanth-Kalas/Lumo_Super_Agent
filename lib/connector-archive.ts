/**
 * Connector response archive — graceful-degradation cache layer.
 *
 * Wraps any per-user connector fetch (YouTube, IG, FB, LinkedIn,
 * Newsletter, Gmail, Calendar, etc.) so that:
 *
 *   1. The hot path serves from `connector_responses_archive` if a
 *      row newer than ttl_seconds exists.
 *   2. On cache miss / stale → upstream is called, and on success the
 *      response is written to the archive.
 *   3. On upstream failure (network, 5xx, 401, 429) we serve the
 *      most-recent cached row past TTL and flag it stale.
 *
 * Used by every connector in /workspace so dashboards keep rendering
 * even when an API is down or a token has expired. The Operations
 * tab reads source='cached' / 'stale' from the result envelope to
 * surface "Cached 12 min ago" pills.
 *
 * Storage: db/migrations/012_workspace_creator.sql →
 *           public.connector_responses_archive.
 *
 * Note: this is a CACHE for raw provider responses, not a normalized
 * data warehouse. Higher-level libs (lib/integrations/youtube.ts) are
 * responsible for normalizing the cached jsonb into typed shapes.
 */

import { createHash } from "node:crypto";
import { getSupabase } from "./db";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArchiveKey {
  user_id: string;
  agent_id: string;
  /** Sub-account, when an OAuth grant covers many. Optional for grants
   *  with a single account (Spotify), required for fanout grants
   *  (Meta, Google→YouTube channels). */
  external_account_id?: string;
  /** Stable identifier for the upstream call ("youtube.channels.list",
   *  "ig.media.insights", etc). One namespace per provider. */
  endpoint: string;
  /** Anything that distinguishes one call from another at the same
   *  endpoint — query params, body, channel id, video id, page tokens.
   *  We canonicalize + hash this server-side so callers don't have to
   *  hand-build a hash. */
  params?: Record<string, unknown>;
}

export interface CacheReadEnvelope<T> {
  /** The decoded response body. */
  data: T;
  /** Where the data came from this call. */
  source: "live" | "cached" | "stale";
  /** Milliseconds since the row was fetched (0 for source='live'). */
  age_ms: number;
  /** ISO timestamp of original fetch (for display in Operations tab). */
  fetched_at: string;
  /** TTL configured for this endpoint (seconds). */
  ttl_seconds: number;
  /** Upstream HTTP status when source='live'; cached status when not. */
  response_status: number;
  /** Set when source='stale'. Null otherwise. */
  upstream_error?: string | null;
}

export interface FetchOptions<T> {
  /** Time-to-live for fresh-from-archive reads. Default 300s (5 min). */
  ttl_seconds?: number;
  /** Set true to mark this row preserved from the 90d sweep. Use for
   *  daily snapshots (channel stats per day) you want to retain for
   *  trend analysis. */
  keep_for_history?: boolean;
  /** The actual upstream call. Returns parsed body + the http status. */
  fetcher: () => Promise<{ data: T; response_status: number }>;
  /** When true, force a live call even if a fresh cached row exists.
   *  Used for "Refresh now" buttons in the dashboard. */
  force_refresh?: boolean;
}

export class ConnectorArchiveDegraded extends Error {
  readonly upstream_error: unknown;
  constructor(message: string, upstream_error: unknown) {
    super(message);
    this.name = "ConnectorArchiveDegraded";
    this.upstream_error = upstream_error;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Hashing
// ──────────────────────────────────────────────────────────────────────────

/**
 * Canonical request hash: stable across invocations as long as the
 * endpoint + params are equivalent. Sorts keys recursively so
 * { a: 1, b: 2 } and { b: 2, a: 1 } collapse to the same hash.
 */
export function requestHash(
  endpoint: string,
  params: Record<string, unknown> | undefined,
  external_account_id: string | undefined,
): string {
  const canonical = JSON.stringify({
    endpoint,
    external_account_id: external_account_id ?? null,
    params: canonicalize(params ?? {}),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

// ──────────────────────────────────────────────────────────────────────────
// Read helpers
// ──────────────────────────────────────────────────────────────────────────

interface ArchiveRow {
  response_status: number;
  response_body: unknown;
  fetched_at: string;
  ttl_seconds: number;
}

async function readLatest(
  key: ArchiveKey,
  hash: string,
): Promise<ArchiveRow | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("connector_responses_archive")
    .select("response_status, response_body, fetched_at, ttl_seconds")
    .eq("user_id", key.user_id)
    .eq("agent_id", key.agent_id)
    .eq("endpoint", key.endpoint)
    .eq("request_hash", hash)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[connector-archive] read error", error);
    return null;
  }
  return (data as ArchiveRow | null) ?? null;
}

async function writeRow(
  key: ArchiveKey,
  hash: string,
  body: unknown,
  status: number,
  ttl: number,
  keep_for_history: boolean,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("connector_responses_archive").insert({
    user_id: key.user_id,
    agent_id: key.agent_id,
    external_account_id: key.external_account_id ?? null,
    endpoint: key.endpoint,
    request_hash: hash,
    response_status: status,
    response_body: body as Record<string, unknown>,
    ttl_seconds: ttl,
    keep_for_history,
  });
  if (error) console.warn("[connector-archive] write error", error);
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fetch with archive. Tries cache → upstream → stale-cache fallback.
 *
 * Caller handles the source field on the envelope:
 *  - 'live'   : data is fresh; show normal UI
 *  - 'cached' : data within TTL but came from archive; treat as fresh
 *  - 'stale'  : upstream failed; show "Cached Xm ago" pill
 *
 * If cache is empty AND upstream fails, throws ConnectorArchiveDegraded.
 * Callers should catch and render an error/reauth state for that card.
 */
export async function fetchWithArchive<T>(
  key: ArchiveKey,
  opts: FetchOptions<T>,
): Promise<CacheReadEnvelope<T>> {
  const ttl = opts.ttl_seconds ?? 300;
  const hash = requestHash(key.endpoint, key.params, key.external_account_id);
  const force = !!opts.force_refresh;

  // 1) Cache check
  const cached = force ? null : await readLatest(key, hash);
  if (cached) {
    const age_ms = Date.now() - new Date(cached.fetched_at).getTime();
    const fresh = age_ms <= cached.ttl_seconds * 1000;
    if (fresh) {
      return {
        data: cached.response_body as T,
        source: "cached",
        age_ms,
        fetched_at: cached.fetched_at,
        ttl_seconds: cached.ttl_seconds,
        response_status: cached.response_status,
        upstream_error: null,
      };
    }
  }

  // 2) Live fetch
  try {
    const live = await opts.fetcher();
    await writeRow(
      key,
      hash,
      live.data,
      live.response_status,
      ttl,
      !!opts.keep_for_history,
    );
    return {
      data: live.data,
      source: "live",
      age_ms: 0,
      fetched_at: new Date().toISOString(),
      ttl_seconds: ttl,
      response_status: live.response_status,
      upstream_error: null,
    };
  } catch (err) {
    // 3) Stale fallback — only if we have any cached row at all (even past TTL).
    const stale = cached ?? (await readLatest(key, hash));
    if (stale) {
      const age_ms = Date.now() - new Date(stale.fetched_at).getTime();
      return {
        data: stale.response_body as T,
        source: "stale",
        age_ms,
        fetched_at: stale.fetched_at,
        ttl_seconds: stale.ttl_seconds,
        response_status: stale.response_status,
        upstream_error: serializeError(err),
      };
    }
    throw new ConnectorArchiveDegraded(
      `Upstream failed and no cached row exists for ${key.agent_id}/${key.endpoint}`,
      err,
    );
  }
}

/**
 * Force an archive write without any read attempt. Used when we already
 * have data in hand (e.g., webhook payload from a platform) and want to
 * persist it as the latest snapshot for future cache reads.
 */
export async function writeArchive<T>(
  key: ArchiveKey,
  body: T,
  opts: { response_status?: number; ttl_seconds?: number; keep_for_history?: boolean } = {},
): Promise<void> {
  const hash = requestHash(key.endpoint, key.params, key.external_account_id);
  await writeRow(
    key,
    hash,
    body,
    opts.response_status ?? 200,
    opts.ttl_seconds ?? 300,
    !!opts.keep_for_history,
  );
}

/**
 * Read-only query for the Operations tab: "what's the freshest row we
 * have for this user+agent+endpoint?" Returns null if nothing cached.
 */
export async function peekArchive<T>(
  key: ArchiveKey,
): Promise<{ data: T; fetched_at: string; age_ms: number } | null> {
  const hash = requestHash(key.endpoint, key.params, key.external_account_id);
  const row = await readLatest(key, hash);
  if (!row) return null;
  return {
    data: row.response_body as T,
    fetched_at: row.fetched_at,
    age_ms: Date.now() - new Date(row.fetched_at).getTime(),
  };
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
