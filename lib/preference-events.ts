import { getSupabase } from "./db.js";
import {
  normalizePreferenceEvents,
  type NormalizedPreferenceEvent,
  type PreferenceEventInput,
} from "./preference-events-core.js";

export interface RecordPreferenceEventsResult {
  ok: boolean;
  inserted: number;
  skipped: number;
  error?: string;
}

export async function recordPreferenceEvents(
  user_id: string,
  input: unknown,
): Promise<RecordPreferenceEventsResult> {
  const normalized = normalizePreferenceEvents(input);
  return insertPreferenceEvents(user_id, normalized, input);
}

export async function recordPreferenceEvent(
  user_id: string,
  input: PreferenceEventInput,
): Promise<RecordPreferenceEventsResult> {
  return recordPreferenceEvents(user_id, input);
}

async function insertPreferenceEvents(
  user_id: string,
  normalized: NormalizedPreferenceEvent[],
  original: unknown,
): Promise<RecordPreferenceEventsResult> {
  const skipped = countRawEvents(original) - normalized.length;
  if (!user_id || normalized.length === 0) {
    return { ok: true, inserted: 0, skipped: Math.max(0, skipped) };
  }

  const db = getSupabase();
  if (!db) {
    return {
      ok: true,
      inserted: 0,
      skipped: Math.max(0, skipped),
      error: "persistence_disabled",
    };
  }

  const rows = normalized.map((event) => ({
    user_id,
    surface: event.surface,
    target_type: event.target_type,
    target_id: event.target_id,
    event_type: event.event_type,
    dwell_ms: event.dwell_ms,
    session_id: event.session_id,
    context: event.context,
    metadata: event.metadata,
  }));

  const { error } = await db.from("preference_events").insert(rows);
  if (error) {
    console.warn("[preference-events] insert failed:", error.message, {
      user_id,
      count: rows.length,
    });
    return {
      ok: false,
      inserted: 0,
      skipped: Math.max(0, skipped),
      error: error.message,
    };
  }

  return {
    ok: true,
    inserted: rows.length,
    skipped: Math.max(0, skipped),
  };
}

function countRawEvents(input: unknown): number {
  if (Array.isArray(input)) return input.length;
  if (
    typeof input === "object" &&
    input !== null &&
    Array.isArray((input as { events?: unknown }).events)
  ) {
    return ((input as { events: unknown[] }).events).length;
  }
  return input ? 1 : 0;
}
