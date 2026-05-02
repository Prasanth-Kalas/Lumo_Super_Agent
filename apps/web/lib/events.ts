/**
 * Append-only event log.
 *
 * Every SSE frame the /api/chat route emits also gets written here,
 * plus the inbound user request and orchestrator-internal decisions
 * (tool retries, saga plan emission, etc.). This is the durable
 * contract that underpins two P0 capabilities:
 *
 *   - Audit: "what did Lumo show the user, exactly, at T?"
 *   - Replay: given a session_id + turn_id, reconstruct the frame
 *     sequence. That reproduces tool calls, selections, the
 *     confirmation card state, and the commit/rollback outcome.
 *
 * Design rules:
 *
 *   1. Writes are fire-and-forget (`void recordEvent(...)`). A slow
 *      Supabase round-trip must never block an SSE frame from
 *      reaching the user. We queue via `Promise.resolve().then(...)`
 *      and swallow+log failures so the audit path can't take down a
 *      live user turn.
 *
 *   2. On in-memory mode (SUPABASE_URL unset) this is a no-op. The
 *      route handler still works — just no audit trail. The P0 gap
 *      closes only when the user sets env vars and runs the
 *      migration.
 *
 *   3. We never mutate events. No update, no delete. If a frame was
 *      wrong, we record a compensating frame; we don't rewrite
 *      history. This matches SOX "WORM" (write-once, read-many)
 *      expectations for audit logs.
 *
 *   4. frame_value is jsonb, so callers can shove whatever structure
 *      the frame carried. The `frame_type` enum is narrow on purpose
 *      — see the migration for the check constraint.
 */

import { getSupabase } from "./db.js";

export type EventFrameType =
  | "text"
  | "mission"
  | "tool"
  | "selection"
  | "assistant_suggestions"
  | "assistant_compound_dispatch"
  | "assistant_compound_step_update"
  | "summary"
  | "leg_status"
  | "error"
  | "done"
  | "request"
  | "internal";

export interface EventRow {
  session_id: string;
  turn_id?: string | null;
  trip_id?: string | null;
  frame_type: EventFrameType;
  frame_value: unknown;
}

/**
 * Fire-and-forget audit write. Never throws. Never awaits more than
 * a microtask so the calling request thread stays snappy.
 *
 * Returns a Promise so callers that actually care about durability
 * (rare — mostly smoke tests) can `await` it.
 */
export function recordEvent(row: EventRow): Promise<void> {
  const db = getSupabase();
  if (!db) return Promise.resolve();

  const payload = {
    session_id: row.session_id,
    turn_id: row.turn_id ?? null,
    trip_id: row.trip_id ?? null,
    frame_type: row.frame_type,
    frame_value: sanitize(row.frame_value),
  };

  // Detach from the caller's microtask so a slow network insert can't
  // hold up an SSE frame. We still return the promise in case a test
  // wants to await it. Wrap in Promise.resolve so we have a native
  // Promise with .catch — Supabase's builder returns a PromiseLike.
  return Promise.resolve(db.from("events").insert(payload))
    .then(({ error }) => {
      if (error) {
        // Don't throw — audit should never take down a live turn.
        console.error(
          "[events] insert failed (non-fatal):",
          error.message,
          { session_id: row.session_id, frame_type: row.frame_type },
        );
      }
    })
    .catch((err: unknown) => {
      console.error(
        "[events] insert threw (non-fatal):",
        err instanceof Error ? err.message : String(err),
        { session_id: row.session_id, frame_type: row.frame_type },
      );
    });
}

/**
 * Best-effort bulk insert. Used on session-end flushes or test
 * harnesses that want to batch. Same non-throwing semantics.
 */
export async function recordEvents(rows: EventRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = getSupabase();
  if (!db) return;

  const payload = rows.map((r) => ({
    session_id: r.session_id,
    turn_id: r.turn_id ?? null,
    trip_id: r.trip_id ?? null,
    frame_type: r.frame_type,
    frame_value: sanitize(r.frame_value),
  }));

  const { error } = await db.from("events").insert(payload);
  if (error) {
    console.error("[events] bulk insert failed (non-fatal):", error.message);
  }
}

/**
 * Read back every event for a session, oldest first. This is the
 * replay path — the shell admin tool reads this and reconstructs
 * what the user saw. Returns `[]` on persistence-disabled mode
 * (not an error; just no durable history to replay).
 */
export async function readSessionEvents(session_id: string): Promise<
  Array<EventRow & { ts: string; event_id: number }>
> {
  const db = getSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from("events")
    .select("event_id, session_id, turn_id, trip_id, frame_type, frame_value, ts")
    .eq("session_id", session_id)
    .order("ts", { ascending: true })
    .order("event_id", { ascending: true });

  if (error) {
    console.error("[events] read failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as Array<
    EventRow & { ts: string; event_id: number }
  >;
}

/**
 * Read events for a single trip. Includes the rendered summary, all
 * leg_status frames, and any errors encountered during dispatch.
 */
export async function readTripEvents(trip_id: string): Promise<
  Array<EventRow & { ts: string; event_id: number }>
> {
  const db = getSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from("events")
    .select("event_id, session_id, turn_id, trip_id, frame_type, frame_value, ts")
    .eq("trip_id", trip_id)
    .order("ts", { ascending: true })
    .order("event_id", { ascending: true });

  if (error) {
    console.error("[events] read failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as Array<
    EventRow & { ts: string; event_id: number }
  >;
}

/**
 * Strip non-JSON-serializable values so the insert never fails because
 * a caller included a `BigInt`, `function`, `undefined`, or a circular
 * reference. Defensive — most callers already pass plain JSON, but
 * tool results from third-party agents can surprise us.
 */
function sanitize(v: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(v, (_key, value) => {
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "function") return undefined;
        return value;
      }),
    );
  } catch {
    return { _lumo_sanitize_failed: true, kind: typeof v };
  }
}
