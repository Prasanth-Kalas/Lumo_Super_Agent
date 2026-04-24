/**
 * Trip state store — Supabase-backed with in-memory fallback.
 *
 * Per-session record of a compound booking in flight. Threads the needle
 * between three modules that otherwise can't see each other:
 *
 *   - `trip-planner.ts` builds a `TripSummaryPayload` from priced legs,
 *   - `saga.ts` plans rollbacks from a `LegExecutionSnapshot[]`,
 *   - `orchestrator.ts` dispatches the confirmed plan and, on failure,
 *     asks the saga what to do.
 *
 * This module stores the trip envelope alongside per-leg status so the
 * orchestrator can feed a snapshot to `planRollback(...)` at any time.
 *
 * Persistence (added in P0 remediation, task #71):
 *
 *   - When SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, every
 *     mutation is written through to Supabase (`trips` + `trip_legs`
 *     tables). Reads hit the in-memory cache first, then fall back to
 *     Supabase on miss — that lets a re-deployed instance pick up
 *     state written by the previous one.
 *
 *   - When env is not set, state stays in-memory only. This keeps
 *     local dev and CI working but obviously provides no audit or
 *     replay. `lib/db.ts` warns once on startup when this happens.
 *
 * All public functions are now async. The orchestrator and route
 * handler already run in async contexts, so the ripple is just
 * adding `await` at each call site.
 *
 * Status lifecycle (`TripStatus`):
 *
 *   draft
 *     │ confirmTrip(hash) — user affirmed, compound hash matches
 *     ▼
 *   confirmed
 *     │ beginDispatch() — orchestrator starts walking legs in DAG order
 *     ▼
 *   dispatching
 *     │ every leg committed   every leg either committed,
 *     │                          rolled_back, or escalated
 *     ▼                          ▼
 *   committed                  rolled_back  ──(retry failed)──▶ rollback_failed
 */

import { hashTripSummary, type TripSummaryPayload } from "@lumo/agent-sdk";
import { getSupabase } from "./db.js";
import type { LegExecutionSnapshot, LegExecutionStatus } from "./saga.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type TripStatus =
  | "draft"
  | "confirmed"
  | "dispatching"
  | "committed"
  | "rolled_back"
  | "rollback_failed";

export interface TripRecord {
  trip_id: string;
  session_id: string;
  status: TripStatus;
  payload: TripSummaryPayload;
  hash: string;
  legs: LegExecutionSnapshot[];
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Errors — callers match on code, not message
// ──────────────────────────────────────────────────────────────────────────

export class TripStateError extends Error {
  readonly code: TripStateErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: TripStateErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "TripStateError";
    this.code = code;
    this.detail = detail;
  }
}

export type TripStateErrorCode =
  | "trip_not_found"
  | "illegal_transition"
  | "hash_mismatch"
  | "unknown_leg"
  | "illegal_leg_transition";

// ──────────────────────────────────────────────────────────────────────────
// In-memory cache (also the authoritative store when Supabase is disabled)
// ──────────────────────────────────────────────────────────────────────────

const byTripId = new Map<string, TripRecord>();
const bySession = new Map<string, string>(); // session_id -> trip_id of the non-terminal trip

function now(): string {
  return new Date().toISOString();
}

let nextTripSuffix = 1;
function mintTripId(): string {
  const ts = Date.now().toString(36);
  const n = (nextTripSuffix++).toString(36).padStart(4, "0");
  return `trip_${ts}${n}`;
}

const TERMINAL: ReadonlySet<TripStatus> = new Set([
  "committed",
  "rolled_back",
  "rollback_failed",
]);

// ──────────────────────────────────────────────────────────────────────────
// Mutations
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create (or replace) a draft trip for a session.
 *
 * If an earlier draft exists for this session, it is discarded — the
 * user pivoted and we don't want the stale summary sitting around. Any
 * non-draft trip for this session blocks a new draft (users must resolve
 * one trip before starting another).
 */
export async function createDraftTrip(
  session_id: string,
  user_id: string,
  payload: TripSummaryPayload,
): Promise<TripRecord> {
  const existing = await getTripBySession(session_id);
  if (existing) {
    if (existing.status !== "draft") {
      throw new TripStateError(
        "illegal_transition",
        `Cannot start a new trip draft for session ${session_id}: an existing trip ${existing.trip_id} is in status "${existing.status}". Resolve it first.`,
        {
          session_id,
          existing_trip_id: existing.trip_id,
          existing_status: existing.status,
        },
      );
    }
    // Discard the previous draft — same-session pivots are fine.
    await deleteTripEverywhere(existing.trip_id, existing.session_id);
  }

  const trip_id = mintTripId();
  const hash = hashTripSummary(payload);
  const legs: LegExecutionSnapshot[] = payload.legs.map((l) => ({
    order: l.order,
    agent_id: l.agent_id,
    tool_name: l.tool_name,
    depends_on: l.depends_on.slice().sort((x, y) => x - y),
    status: "pending",
  }));

  const record: TripRecord = {
    trip_id,
    session_id,
    status: "draft",
    payload,
    hash,
    legs,
    created_at: now(),
    updated_at: now(),
  };

  // Cache first so a failed DB write still returns something the
  // orchestrator can use for this turn.
  byTripId.set(trip_id, record);
  bySession.set(session_id, trip_id);

  await persistTrip(record, user_id);
  await persistLegs(trip_id, legs);

  return record;
}

/**
 * Advance `draft` → `confirmed`. Requires the user's affirmation-turn
 * hash to match the stored compound hash exactly. This is the anchor
 * of the compound-confirmation gate.
 */
export async function confirmTrip(
  trip_id: string,
  provided_hash: string,
): Promise<TripRecord> {
  const t = await requireTrip(trip_id);
  if (t.status !== "draft") {
    throw new TripStateError(
      "illegal_transition",
      `Cannot confirm trip ${trip_id}: status is "${t.status}", expected "draft".`,
      { trip_id, current_status: t.status },
    );
  }
  if (provided_hash !== t.hash) {
    throw new TripStateError(
      "hash_mismatch",
      `Provided confirmation hash does not match trip ${trip_id}.`,
      { trip_id },
    );
  }
  t.status = "confirmed";
  t.updated_at = now();
  byTripId.set(trip_id, t);
  await updateTripStatus(trip_id, "confirmed");
  return t;
}

/**
 * Advance `confirmed` → `dispatching`. Called just before the first
 * forward tool call of the trip.
 */
export async function beginDispatch(trip_id: string): Promise<TripRecord> {
  const t = await requireTrip(trip_id);
  if (t.status !== "confirmed") {
    throw new TripStateError(
      "illegal_transition",
      `Cannot begin dispatch on trip ${trip_id}: status is "${t.status}", expected "confirmed".`,
      { trip_id, current_status: t.status },
    );
  }
  t.status = "dispatching";
  t.updated_at = now();
  byTripId.set(trip_id, t);
  await updateTripStatus(trip_id, "dispatching");
  return t;
}

/**
 * Update one leg's execution status. The legal per-leg transition
 * graph is enforced here.
 */
export async function updateLeg(
  trip_id: string,
  order: number,
  patch: {
    status: LegExecutionStatus;
    booking_id?: string;
    error_detail?: Record<string, unknown>;
  },
): Promise<TripRecord> {
  const t = await requireTrip(trip_id);
  const leg = t.legs.find((l) => l.order === order);
  if (!leg) {
    throw new TripStateError(
      "unknown_leg",
      `Trip ${trip_id} has no leg with order ${order}.`,
      { trip_id, order },
    );
  }
  if (!isLegalLegTransition(leg.status, patch.status)) {
    throw new TripStateError(
      "illegal_leg_transition",
      `Cannot move leg ${order} from "${leg.status}" to "${patch.status}".`,
      { trip_id, order, from: leg.status, to: patch.status },
    );
  }
  leg.status = patch.status;
  if (patch.booking_id !== undefined) leg.booking_id = patch.booking_id;
  if (patch.error_detail !== undefined) leg.error_detail = patch.error_detail;
  t.updated_at = now();
  byTripId.set(trip_id, t);
  await persistLegPatch(trip_id, order, leg);
  return t;
}

/**
 * Terminal status transitions from `dispatching` → committed |
 * rolled_back | rollback_failed. The caller verifies the condition;
 * this module trusts the caller's judgement on which terminal applies.
 *
 * Also clears the session→trip index so the next user intent can start
 * a new draft without tripping the "one live trip per session" rule.
 */
export async function finalizeTrip(
  trip_id: string,
  terminal: "committed" | "rolled_back" | "rollback_failed",
): Promise<TripRecord> {
  const t = await requireTrip(trip_id);
  if (t.status !== "dispatching") {
    throw new TripStateError(
      "illegal_transition",
      `Cannot finalize trip ${trip_id} as "${terminal}": current status is "${t.status}", expected "dispatching".`,
      { trip_id, current_status: t.status, terminal },
    );
  }
  t.status = terminal;
  t.updated_at = now();
  byTripId.set(trip_id, t);

  // Clear the session→trip index when the trip terminates. The trip
  // row stays in Postgres for audit; we just stop surfacing it as the
  // active trip for this session so a new draft can be started.
  if (bySession.get(t.session_id) === trip_id) {
    bySession.delete(t.session_id);
  }

  await updateTripStatus(trip_id, terminal);
  return t;
}

// ──────────────────────────────────────────────────────────────────────────
// Reads
// ──────────────────────────────────────────────────────────────────────────

export async function getTripById(trip_id: string): Promise<TripRecord | null> {
  const cached = byTripId.get(trip_id);
  if (cached) return cached;
  const loaded = await loadTripFromDb({ trip_id });
  if (loaded) {
    byTripId.set(trip_id, loaded);
    if (!TERMINAL.has(loaded.status)) {
      bySession.set(loaded.session_id, trip_id);
    }
  }
  return loaded;
}

export async function getTripBySession(
  session_id: string,
): Promise<TripRecord | null> {
  const cachedId = bySession.get(session_id);
  if (cachedId) {
    const t = byTripId.get(cachedId);
    if (t) return t;
  }
  const loaded = await loadTripFromDb({ session_id });
  if (loaded) {
    byTripId.set(loaded.trip_id, loaded);
    if (!TERMINAL.has(loaded.status)) {
      bySession.set(session_id, loaded.trip_id);
    }
  }
  return loaded;
}

/**
 * Snapshot the per-leg execution status for the saga. Deep-copies so
 * saga can't accidentally mutate store state.
 */
export async function snapshot(trip_id: string): Promise<LegExecutionSnapshot[]> {
  const t = await requireTrip(trip_id);
  return t.legs.map((l) => ({
    order: l.order,
    agent_id: l.agent_id,
    tool_name: l.tool_name,
    depends_on: l.depends_on.slice(),
    status: l.status,
    booking_id: l.booking_id,
    error_detail: l.error_detail ? { ...l.error_detail } : undefined,
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// Test hook
// ──────────────────────────────────────────────────────────────────────────

export function __resetForTesting(): void {
  byTripId.clear();
  bySession.clear();
  nextTripSuffix = 1;
}

// ──────────────────────────────────────────────────────────────────────────
// Internals — DB writes + reads
// ──────────────────────────────────────────────────────────────────────────

async function requireTrip(trip_id: string): Promise<TripRecord> {
  const t = await getTripById(trip_id);
  if (!t) {
    throw new TripStateError(
      "trip_not_found",
      `No trip with id ${trip_id}.`,
      { trip_id },
    );
  }
  return t;
}

async function persistTrip(record: TripRecord, user_id: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from("trips").insert({
    trip_id: record.trip_id,
    session_id: record.session_id,
    user_id,
    status: record.status,
    hash: record.hash,
    payload: record.payload as unknown as object,
    created_at: record.created_at,
    updated_at: record.updated_at,
  });
  if (error) {
    console.error("[trip-state] persistTrip failed:", error.message);
  }
}

async function persistLegs(
  trip_id: string,
  legs: LegExecutionSnapshot[],
): Promise<void> {
  const db = getSupabase();
  if (!db || legs.length === 0) return;
  const rows = legs.map((l) => ({
    trip_id,
    order: l.order,
    agent_id: l.agent_id,
    tool_name: l.tool_name,
    depends_on: l.depends_on,
    status: l.status,
    booking_id: l.booking_id ?? null,
    error_detail: l.error_detail ?? null,
  }));
  const { error } = await db.from("trip_legs").insert(rows);
  if (error) {
    console.error("[trip-state] persistLegs failed:", error.message);
  }
}

async function persistLegPatch(
  trip_id: string,
  order: number,
  leg: LegExecutionSnapshot,
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db
    .from("trip_legs")
    .update({
      status: leg.status,
      booking_id: leg.booking_id ?? null,
      error_detail: leg.error_detail ?? null,
    })
    .eq("trip_id", trip_id)
    .eq("order", order);
  if (error) {
    console.error(
      `[trip-state] persistLegPatch failed (trip=${trip_id} order=${order}):`,
      error.message,
    );
  }
}

async function updateTripStatus(
  trip_id: string,
  status: TripStatus,
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db
    .from("trips")
    .update({ status })
    .eq("trip_id", trip_id);
  if (error) {
    console.error(
      `[trip-state] updateTripStatus failed (trip=${trip_id}):`,
      error.message,
    );
  }
}

async function deleteTripEverywhere(
  trip_id: string,
  session_id: string,
): Promise<void> {
  byTripId.delete(trip_id);
  if (bySession.get(session_id) === trip_id) bySession.delete(session_id);

  const db = getSupabase();
  if (!db) return;
  // trip_legs cascades on delete.
  const { error } = await db.from("trips").delete().eq("trip_id", trip_id);
  if (error) {
    console.error(
      `[trip-state] deleteTrip failed (trip=${trip_id}):`,
      error.message,
    );
  }
}

/**
 * Load a trip from Postgres by trip_id OR by session_id (for the
 * "is there a live trip for this session" check). Returns null on
 * persistence-disabled mode OR on genuine miss.
 *
 * When loading by session_id, we restrict to non-terminal trips —
 * matches the partial unique index in the migration.
 */
async function loadTripFromDb(
  key: { trip_id: string } | { session_id: string },
): Promise<TripRecord | null> {
  const db = getSupabase();
  if (!db) return null;

  let query = db
    .from("trips")
    .select("trip_id, session_id, status, hash, payload, created_at, updated_at");

  if ("trip_id" in key) {
    query = query.eq("trip_id", key.trip_id);
  } else {
    query = query
      .eq("session_id", key.session_id)
      .in("status", ["draft", "confirmed", "dispatching"]);
  }

  const { data: tripRows, error: tripErr } = await query.limit(1);
  if (tripErr) {
    console.error("[trip-state] loadTrip failed:", tripErr.message);
    return null;
  }
  const tripRow = tripRows?.[0];
  if (!tripRow) return null;

  const { data: legRows, error: legErr } = await db
    .from("trip_legs")
    .select("order, agent_id, tool_name, depends_on, status, booking_id, error_detail")
    .eq("trip_id", tripRow.trip_id)
    .order("order", { ascending: true });
  if (legErr) {
    console.error("[trip-state] loadLegs failed:", legErr.message);
    return null;
  }

  const legs: LegExecutionSnapshot[] = (legRows ?? []).map((r) => ({
    order: Number(r.order),
    agent_id: String(r.agent_id),
    tool_name: String(r.tool_name),
    depends_on: Array.isArray(r.depends_on)
      ? (r.depends_on as number[]).slice()
      : [],
    status: r.status as LegExecutionStatus,
    booking_id: r.booking_id ?? undefined,
    error_detail:
      r.error_detail && typeof r.error_detail === "object"
        ? (r.error_detail as Record<string, unknown>)
        : undefined,
  }));

  return {
    trip_id: String(tripRow.trip_id),
    session_id: String(tripRow.session_id),
    status: tripRow.status as TripStatus,
    hash: String(tripRow.hash),
    payload: tripRow.payload as unknown as TripSummaryPayload,
    legs,
    created_at: String(tripRow.created_at),
    updated_at: String(tripRow.updated_at),
  };
}

/**
 * Legal per-leg transitions. Keep narrow — any move not listed is a
 * bug, not a feature.
 */
function isLegalLegTransition(
  from: LegExecutionStatus,
  to: LegExecutionStatus,
): boolean {
  if (from === to) return true;
  switch (from) {
    case "pending":
      return to === "in_flight" || to === "failed";
    case "in_flight":
      return to === "committed" || to === "failed";
    case "committed":
      return to === "rolled_back" || to === "rollback_failed";
    case "rollback_failed":
      return to === "rolled_back";
    case "failed":
    case "rolled_back":
      return false;
    default:
      return false;
  }
}
