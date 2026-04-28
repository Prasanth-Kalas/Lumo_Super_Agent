/**
 * Admin settings — runtime knobs the operator console can flip
 * without a deploy.
 *
 * Two-layer cache:
 *   - Per-process Map, populated on first read and refreshed every
 *     ADMIN_SETTINGS_TTL_MS. Settings change rarely; reading from
 *     Supabase on every chat turn would be wasteful.
 *   - On write (setSetting), the cache is invalidated so the next
 *     read sees the new value within one cycle. Other instances of
 *     the serverless function pick up the change at most TTL later.
 *
 * Fallbacks: every getSetting call takes a `fallback` arg. If the
 * row is missing, the DB is unreachable, or the cached value is
 * stale-and-failing, we return the fallback rather than throwing.
 * This keeps the chat turn alive even if Supabase is having a
 * moment.
 */

import { getSupabase } from "./db.js";

const ADMIN_SETTINGS_TTL_MS = 30_000;

interface CacheEntry {
  value: unknown;
  fetched_at: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Known settings keys. Centralized so a typo at a callsite fails at
 * compile time instead of silently using a fallback forever.
 */
export type AdminSettingKey =
  | "llm.model"
  | "voice.provider"
  | "voice.model"
  | "voice.voice_id"
  | "voice.stability"
  | "voice.similarity_boost"
  | "voice.style"
  | "feature.mcp_enabled"
  | "feature.partner_agents_enabled"
  | "feature.voice_mode_enabled"
  | "feature.autonomy_enabled"
  | "prompt.voice_mode_addendum"
  | "prompt.text_mode_addendum";

export interface AdminSettingRow {
  key: string;
  value: unknown;
  updated_at: string;
  updated_by: string | null;
}

export interface AdminSettingHistoryRow {
  id: string;
  key: string;
  value: unknown;
  recorded_at: string;
  recorded_by: string | null;
}

/**
 * Read one setting with a typed fallback. Cached per process for
 * ADMIN_SETTINGS_TTL_MS so chat turns aren't gated on Supabase.
 *
 * Generic T: the caller asserts what shape they expect. We don't
 * runtime-validate (the value column is JSONB so any JSON value is
 * possible) — callers should pick fallbacks defensively.
 */
export async function getSetting<T>(
  key: AdminSettingKey,
  fallback: T,
): Promise<T> {
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.fetched_at < ADMIN_SETTINGS_TTL_MS) {
    return cached.value as T;
  }

  const sb = getSupabase();
  if (!sb) return fallback;

  try {
    const { data, error } = await sb
      .from("admin_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) {
      // Don't kill the cache — keep serving the last good value.
      // Only fall back to the caller's default if we have nothing
      // cached at all.
      console.warn(`[admin-settings] read ${key} failed:`, error.message);
      return cached ? (cached.value as T) : fallback;
    }
    if (!data) {
      cache.set(key, { value: fallback, fetched_at: now });
      return fallback;
    }
    const value = (data as { value: unknown }).value;
    cache.set(key, { value, fetched_at: now });
    return value as T;
  } catch (err) {
    console.warn(`[admin-settings] read ${key} threw:`, err);
    return cached ? (cached.value as T) : fallback;
  }
}

/**
 * Update one setting and append to history. Returns the new row.
 * Caller is expected to be admin-authorized — this module doesn't
 * re-check; the route handler does.
 */
export async function setSetting(
  key: AdminSettingKey,
  value: unknown,
  updated_by: string,
): Promise<AdminSettingRow> {
  const sb = getSupabase();
  if (!sb) throw new Error("db_unavailable");

  // Append to history first (best-effort). If the upsert below
  // fails we still want a record of the attempt.
  void sb
    .from("admin_settings_history")
    .insert({ key, value, recorded_by: updated_by });

  const { data, error } = await sb
    .from("admin_settings")
    .upsert(
      {
        key,
        value,
        updated_by,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    )
    .select("key, value, updated_at, updated_by")
    .single();

  if (error) throw new Error(error.message);

  // Invalidate the per-process cache so the next read sees the new
  // value immediately. Other instances pick up at TTL.
  cache.delete(key);

  return data as AdminSettingRow;
}

/**
 * List every setting (admin dashboard list view). Bypasses the
 * cache so the dashboard shows authoritative state.
 */
export async function listSettings(): Promise<AdminSettingRow[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("admin_settings")
    .select("key, value, updated_at, updated_by")
    .order("key");
  if (error) {
    console.warn("[admin-settings] list failed:", error.message);
    return [];
  }
  return (data ?? []) as AdminSettingRow[];
}

/**
 * Read the recent history for one key. Powers the rollback UI on
 * settings whose value is risky to change (system prompt overrides
 * especially).
 */
export async function listSettingHistory(
  key: AdminSettingKey,
  limit = 20,
): Promise<AdminSettingHistoryRow[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("admin_settings_history")
    .select("id, key, value, recorded_at, recorded_by")
    .eq("key", key)
    .order("recorded_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[admin-settings] history read failed:", error.message);
    return [];
  }
  return (data ?? []) as AdminSettingHistoryRow[];
}

/**
 * Convenience wrapper for boolean feature flags. Evaluates true ONLY
 * if the stored value is exactly the boolean `true`. Any other
 * value (false, missing, malformed) is treated as false. That makes
 * "fail closed" the default — a corrupted setting can't accidentally
 * enable a feature.
 */
export async function isFeatureEnabled(
  flag: Extract<AdminSettingKey, `feature.${string}`>,
  fallback = false,
): Promise<boolean> {
  const v = await getSetting<unknown>(flag, fallback);
  return v === true;
}

/**
 * Force a cache flush. Test-only, but exported so we can wire a
 * "reload" button on the dashboard later if needed.
 */
export function clearAdminSettingsCache(): void {
  cache.clear();
}
