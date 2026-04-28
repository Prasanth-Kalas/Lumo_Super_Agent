/**
 * Notifications DAO.
 *
 * Single entry point for reading/writing the proactive-alert outbox.
 * Powers:
 *   - /api/cron/proactive-scan  (writes: deliver())
 *   - /api/cron/evaluate-intents (writes: deliver())
 *   - /api/notifications        (reads + mark-read)
 *   - NotificationBell client   (via the above)
 *
 * Dedup is structural: deliver() uses INSERT ... ON CONFLICT DO NOTHING
 * against the partial unique index on (user_id, dedup_key). That means
 * the same proactive rule can re-fire freely after the user reads the
 * alert or it expires — the index silently no-ops while the original
 * is still live.
 */

import { randomBytes } from "node:crypto";
import { getSupabase } from "./db.js";

export type NotificationKind =
  | "trip_stuck"
  | "trip_rolled_back"
  | "trip_committed"
  | "token_expiring"
  | "intent_due"
  | "intent_missed"
  | "order_delivered"
  | "info"
  | "other";

export interface Notification {
  id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  dedup_key: string;
  read_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliverArgs {
  user_id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  /** Stable key so the same rule doesn't create two live notifications. */
  dedup_key: string;
  /**
   * When to stop showing this notification as "live" even if unread.
   * For "trip_stuck" this is typically the trip's expected finalize
   * window + margin; for "token_expiring" it's the token's actual
   * expiry. Omit to keep the notification live until read.
   */
  expires_at?: Date | null;
}

/**
 * Best-effort deliver. Returns the notification row if inserted, or null
 * if a live duplicate already exists (idempotent re-scan). Errors log
 * but don't throw — proactive scans should never crash a cron run.
 */
export async function deliver(args: DeliverArgs): Promise<Notification | null> {
  const db = getSupabase();
  if (!db) return null;

  const id = `ntf_${randomBytes(9).toString("base64url")}`;
  const row = {
    id,
    user_id: args.user_id,
    kind: args.kind,
    title: args.title,
    body: args.body ?? null,
    payload: args.payload ?? {},
    dedup_key: args.dedup_key,
    expires_at: args.expires_at ? args.expires_at.toISOString() : null,
  };

  // PostgREST doesn't support ON CONFLICT DO NOTHING via the REST layer
  // directly, but an insert that violates the partial unique index
  // returns a 409 / duplicate key error. We swallow that specific code
  // and treat it as success-by-idempotency.
  const { data, error } = await db
    .from("notifications")
    .insert(row)
    .select(
      "id, user_id, kind, title, body, payload, dedup_key, read_at, expires_at, created_at, updated_at",
    )
    .single();

  if (error) {
    const code = (error as { code?: string }).code ?? "";
    // 23505 = unique_violation in Postgres. The partial index tripped,
    // which means there's already a live duplicate. That's success.
    if (code === "23505") return null;
    console.error("[notifications] deliver failed:", error.message);
    return null;
  }
  return data as Notification;
}

export async function listForUser(
  userId: string,
  opts?: { unreadOnly?: boolean; limit?: number; beforeTs?: string },
): Promise<Notification[]> {
  const db = getSupabase();
  if (!db) return [];
  let q = db
    .from("notifications")
    .select(
      "id, user_id, kind, title, body, payload, dedup_key, read_at, expires_at, created_at, updated_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 50);
  if (opts?.unreadOnly) q = q.is("read_at", null);
  if (opts?.beforeTs) q = q.lt("created_at", opts.beforeTs);
  const { data, error } = await q;
  if (error) {
    console.error("[notifications] listForUser failed:", error.message);
    return [];
  }
  return (data ?? []) as Notification[];
}

export async function countUnread(userId: string): Promise<number> {
  const db = getSupabase();
  if (!db) return 0;
  const { count, error } = await db
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);
  if (error) {
    console.error("[notifications] countUnread failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

export async function markRead(userId: string, id: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const now = new Date().toISOString();
  const { error } = await db
    .from("notifications")
    .update({ read_at: now })
    .eq("id", id)
    .eq("user_id", userId)
    .is("read_at", null);
  if (error) {
    console.error("[notifications] markRead failed:", error.message);
  }
}

export async function markAllRead(userId: string): Promise<number> {
  const db = getSupabase();
  if (!db) return 0;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("notifications")
    .update({ read_at: now })
    .eq("user_id", userId)
    .is("read_at", null)
    .select("id");
  if (error) {
    console.error("[notifications] markAllRead failed:", error.message);
    return 0;
  }
  return (data ?? []).length;
}
