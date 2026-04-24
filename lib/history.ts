/**
 * Chat + order history reader.
 *
 * Powers the /history page. Reads from the same tables persistence
 * already writes to (trips, events) — no new schema. If Supabase
 * isn't configured we return empty arrays rather than erroring; the
 * page handles that gracefully with a "history requires Supabase"
 * empty state.
 *
 * Privacy guarantee: every read is scoped to a user_id. A user can
 * only see their own history. The callsite (the /api/history route)
 * enforces this; this library just trusts the user_id passed in.
 */

import { getSupabase } from "./db.js";

export interface TripHistoryRow {
  trip_id: string;
  session_id: string;
  status: string;
  payload: {
    trip_title?: string;
    total_amount?: string;
    currency?: string;
    legs?: Array<{
      order: number;
      agent_id: string;
      tool_name?: string;
      summary?: { kind?: string; payload?: unknown };
    }>;
  };
  created_at: string;
  updated_at: string;
  /** Null unless the user tapped Cancel. */
  cancel_requested_at: string | null;
}

export interface SessionHistoryRow {
  session_id: string;
  /** Earliest event for this session — the "when the conversation started" marker. */
  started_at: string;
  /** Latest event — "last activity". */
  last_activity_at: string;
  /** How many request frames (user messages) were recorded. */
  user_message_count: number;
  /** Best-effort preview of the first user message so the list isn't all uuids. */
  preview: string | null;
  /** Any trip_id that was created during this session, newest first. */
  trip_ids: string[];
}

/**
 * List a user's trips, newest first. This is the "order history" the
 * user sees in the side panel — every time Lumo has booked or
 * attempted to book something on their behalf.
 */
export async function listTripsForUser(
  user_id: string,
  limit = 50,
): Promise<TripHistoryRow[]> {
  const db = getSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from("trips")
    .select(
      "trip_id, session_id, status, payload, created_at, updated_at, cancel_requested_at",
    )
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));

  if (error) {
    console.error("[history] listTripsForUser failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as TripHistoryRow[];
}

/**
 * List the sessions the user has had. Aggregates the `events` table
 * — one row per session with a first-activity timestamp, a
 * last-activity timestamp, and the first user message as a preview.
 *
 * Done in two queries: (1) pull session metadata for all events the
 * user authored; (2) for each session, find the first user message
 * for the preview. Could be one query with a CTE if we moved it
 * server-side, but keeping it in two trips is fine for a side panel
 * that renders rarely.
 */
export async function listSessionsForUser(
  user_id: string,
  limit = 30,
): Promise<SessionHistoryRow[]> {
  const db = getSupabase();
  if (!db) return [];

  // Every inbound user message is recorded as a `request` event with
  // user_id in frame_value. We use the `request` stream as the
  // canonical "sessions the user has had" index — no events, no
  // history.
  const { data: requests, error } = await db
    .from("events")
    .select("session_id, frame_value, ts")
    .eq("frame_type", "request")
    // frame_value is jsonb; Supabase can filter by it via ->> syntax.
    .filter("frame_value->>user_id", "eq", user_id)
    .order("ts", { ascending: false })
    .limit(1000); // we'll group + slice below

  if (error) {
    console.error("[history] listSessionsForUser (requests) failed:", error.message);
    return [];
  }

  type Acc = {
    session_id: string;
    started_at: string;
    last_activity_at: string;
    user_message_count: number;
    preview: string | null;
  };
  const bySession = new Map<string, Acc>();

  for (const row of requests ?? []) {
    const sid = String(row.session_id ?? "");
    if (!sid) continue;
    const ts = String(row.ts ?? "");
    const fv = (row.frame_value ?? {}) as Record<string, unknown>;
    const msg =
      typeof fv["last_user_message"] === "string"
        ? (fv["last_user_message"] as string)
        : null;

    const existing = bySession.get(sid);
    if (existing) {
      existing.user_message_count += 1;
      // requests are DESC by ts — so the first one we see is the
      // latest activity, and subsequent older ones push started_at
      // back; the oldest one's message is also the preview.
      existing.started_at = ts < existing.started_at ? ts : existing.started_at;
      existing.preview = msg ?? existing.preview;
    } else {
      bySession.set(sid, {
        session_id: sid,
        started_at: ts,
        last_activity_at: ts,
        user_message_count: 1,
        preview: msg,
      });
    }
  }

  const sessions = Array.from(bySession.values())
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
    .slice(0, Math.max(1, Math.min(100, limit)));

  if (sessions.length === 0) return [];

  // Decorate each session with the trip_ids created during it, if
  // any. Single batched query.
  const sessionIds = sessions.map((s) => s.session_id);
  const { data: trips, error: tripErr } = await db
    .from("trips")
    .select("trip_id, session_id, created_at")
    .in("session_id", sessionIds)
    .order("created_at", { ascending: false });
  if (tripErr) {
    console.error("[history] listSessionsForUser (trips) failed:", tripErr.message);
  }

  const tripBySession = new Map<string, string[]>();
  for (const t of trips ?? []) {
    const sid = String(t.session_id ?? "");
    if (!sid) continue;
    const arr = tripBySession.get(sid) ?? [];
    arr.push(String(t.trip_id));
    tripBySession.set(sid, arr);
  }

  return sessions.map((s) => ({
    ...s,
    trip_ids: tripBySession.get(s.session_id) ?? [],
  }));
}

/**
 * Fetch a trip by id, scoped to the owning user. Returns null if
 * the trip doesn't exist OR belongs to someone else (same response
 * shape — don't leak existence). Used by the history detail panel
 * to render a single past trip's cards + status.
 */
export async function getTripForUser(
  trip_id: string,
  user_id: string,
): Promise<TripHistoryRow | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data, error } = await db
    .from("trips")
    .select(
      "trip_id, session_id, user_id, status, payload, created_at, updated_at, cancel_requested_at",
    )
    .eq("trip_id", trip_id)
    .limit(1);

  if (error) {
    console.error("[history] getTripForUser failed:", error.message);
    return null;
  }
  const row = data?.[0];
  if (!row) return null;
  if (row.user_id !== user_id) return null;
  // Strip user_id from the returned shape.
  const { user_id: _omit, ...rest } = row as Record<string, unknown>;
  void _omit;
  return rest as unknown as TripHistoryRow;
}
