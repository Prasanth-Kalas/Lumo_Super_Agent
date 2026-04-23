/**
 * Trip state store.
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
 * Scope & lifetime:
 *
 *   - One trip per session is plenty for v1 — we're not modelling
 *     overlapping trip drafts. If a new intent arrives while an earlier
 *     trip is still in `draft`, the orchestrator replaces it (and emits
 *     a log line so we can measure how often that happens).
 *
 *   - Storage is **in-memory**. That's fine for the web shell's single
 *     node + vercel dev boundary but obviously wrong for prod (two web
 *     dynos, two memories, split brain). Once the hotel agent ships
 *     we'll move this to Supabase Postgres with row-level locks. The
 *     interface is small on purpose — the swap is local to this file.
 *
 *   - State is keyed by `session_id`. Trip IDs are generated here and
 *     returned to the caller; callers persist the trip_id on the chat
 *     session record for cross-request resume.
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
 *
 * A draft that never gets confirmed simply falls off when the session
 * ends; there's no explicit `expired` state — the GC path replaces it
 * when the next trip starts.
 *
 * Everything here is pure and synchronous so the orchestrator can run
 * it inside its tool-use loop without awaiting I/O. The `saga.ts`
 * planner reads `snapshot()` output directly — they share
 * `LegExecutionSnapshot` from saga.ts.
 */

import { hashTripSummary, type TripSummaryPayload } from "@lumo/agent-sdk";
import type { LegExecutionSnapshot, LegExecutionStatus } from "./saga.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/**
 * Top-level status of a compound booking. See module-level comment for
 * the transition diagram.
 */
export type TripStatus =
  | "draft"            // awaiting user confirmation
  | "confirmed"        // user affirmed; hash matched; dispatch not yet begun
  | "dispatching"      // orchestrator is walking legs in DAG order
  | "committed"        // every leg committed successfully
  | "rolled_back"      // some leg failed; compensating cancels ran clean
  | "rollback_failed"; // rollback itself failed — ops must intervene

export interface TripRecord {
  trip_id: string;
  session_id: string;
  status: TripStatus;
  /** The exact payload the user sees in the confirmation card. */
  payload: TripSummaryPayload;
  /** sha256 hex from hashTripSummary(payload). */
  hash: string;
  /** Per-leg execution snapshot the saga reads verbatim. */
  legs: LegExecutionSnapshot[];
  /** ISO 8601 timestamp of creation. */
  created_at: string;
  /** ISO 8601 timestamp of last status or leg change. */
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
  | "illegal_transition"   // tried to advance status from an incompatible state
  | "hash_mismatch"        // user-confirm carried wrong hash
  | "unknown_leg"          // tried to update a leg not in the trip's DAG
  | "illegal_leg_transition"; // per-leg status move that doesn't respect the status graph

// ──────────────────────────────────────────────────────────────────────────
// Store — swap with Supabase later
// ──────────────────────────────────────────────────────────────────────────

/**
 * Two indexes to avoid O(N) scans in either lookup direction. We only
 * ever hold one trip per session, so `bySession` is cardinality-1 per
 * session_id — but we still key by trip_id for audit paths where the
 * orchestrator has the id and not the session.
 */
const byTripId = new Map<string, TripRecord>();
const bySession = new Map<string, string>(); // session_id -> trip_id

function now(): string {
  return new Date().toISOString();
}

/**
 * Generate a trip id. Short, url-safe, and avoids the `crypto` import —
 * we only need identifier uniqueness within a process for in-memory
 * storage. The prod Supabase migration will use uuid v7 instead; the
 * shape is opaque to callers.
 */
let nextTripSuffix = 1;
function mintTripId(): string {
  const ts = Date.now().toString(36);
  const n = (nextTripSuffix++).toString(36).padStart(4, "0");
  return `trip_${ts}${n}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Mutations
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create (or replace) a draft trip for a session.
 *
 * If a draft already exists for this session, it is discarded — the
 * user pivoted from "flight+hotel" to "flight+hotel+dinner" and we
 * don't want the stale summary sitting around. Any non-draft trip for
 * this session is preserved; callers must resolve that trip (commit or
 * roll back) before starting a new one.
 */
export function createDraftTrip(
  session_id: string,
  payload: TripSummaryPayload,
): TripRecord {
  const existingId = bySession.get(session_id);
  if (existingId) {
    const existing = byTripId.get(existingId);
    if (existing && existing.status !== "draft") {
      throw new TripStateError(
        "illegal_transition",
        `Cannot start a new trip draft for session ${session_id}: an existing trip ${existingId} is in status "${existing.status}". Resolve it first.`,
        { session_id, existing_trip_id: existingId, existing_status: existing.status },
      );
    }
    if (existing) byTripId.delete(existingId);
  }

  const trip_id = mintTripId();
  const hash = hashTripSummary(payload);
  // Seed each leg in `pending` — nothing has been dispatched yet.
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
  byTripId.set(trip_id, record);
  bySession.set(session_id, trip_id);
  return record;
}

/**
 * Advance `draft` → `confirmed`. Requires the hash the user's
 * affirmation turn carried (forwarded by the shell's money-gate) to
 * match the stored compound hash exactly. This is the single place the
 * compound confirmation gate anchors.
 */
export function confirmTrip(trip_id: string, provided_hash: string): TripRecord {
  const t = requireTrip(trip_id);
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
  return t;
}

/**
 * Advance `confirmed` → `dispatching`. Orchestrator calls this just
 * before the first forward tool call of the trip.
 */
export function beginDispatch(trip_id: string): TripRecord {
  const t = requireTrip(trip_id);
  if (t.status !== "confirmed") {
    throw new TripStateError(
      "illegal_transition",
      `Cannot begin dispatch on trip ${trip_id}: status is "${t.status}", expected "confirmed".`,
      { trip_id, current_status: t.status },
    );
  }
  t.status = "dispatching";
  t.updated_at = now();
  return t;
}

/**
 * Update one leg's execution status. The legal per-leg transition
 * graph is enforced here — illegal moves (e.g. `committed → pending`)
 * throw `illegal_leg_transition`.
 */
export function updateLeg(
  trip_id: string,
  order: number,
  patch: {
    status: LegExecutionStatus;
    booking_id?: string;
    error_detail?: Record<string, unknown>;
  },
): TripRecord {
  const t = requireTrip(trip_id);
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
  return t;
}

/**
 * Terminal status transitions: `dispatching` →
 *   - `committed`       (caller verified every leg is committed)
 *   - `rolled_back`     (saga ran clean)
 *   - `rollback_failed` (saga retries exhausted; ops escalation emitted)
 *
 * The caller is responsible for verifying the condition; this module
 * trusts the caller's judgement on which terminal state applies.
 */
export function finalizeTrip(
  trip_id: string,
  terminal: "committed" | "rolled_back" | "rollback_failed",
): TripRecord {
  const t = requireTrip(trip_id);
  if (t.status !== "dispatching") {
    throw new TripStateError(
      "illegal_transition",
      `Cannot finalize trip ${trip_id} as "${terminal}": current status is "${t.status}", expected "dispatching".`,
      { trip_id, current_status: t.status, terminal },
    );
  }
  t.status = terminal;
  t.updated_at = now();
  return t;
}

// ──────────────────────────────────────────────────────────────────────────
// Reads
// ──────────────────────────────────────────────────────────────────────────

export function getTripById(trip_id: string): TripRecord | null {
  return byTripId.get(trip_id) ?? null;
}

export function getTripBySession(session_id: string): TripRecord | null {
  const id = bySession.get(session_id);
  if (!id) return null;
  return byTripId.get(id) ?? null;
}

/**
 * Snapshot the per-leg execution status for the saga. Returns a deep
 * copy so mutations on the returned array don't leak back into the
 * store — saga is pure and shouldn't mutate, but defensive copying
 * keeps future refactors honest.
 */
export function snapshot(trip_id: string): LegExecutionSnapshot[] {
  const t = requireTrip(trip_id);
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
// Test hook — clear everything. NOT exported from index.ts to production.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Clear all in-memory state. Only used from the smoke harness; do not
 * call from request handlers (it would nuke in-flight trips on other
 * sessions).
 */
export function __resetForTesting(): void {
  byTripId.clear();
  bySession.clear();
  nextTripSuffix = 1;
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

function requireTrip(trip_id: string): TripRecord {
  const t = byTripId.get(trip_id);
  if (!t) {
    throw new TripStateError(
      "trip_not_found",
      `No trip with id ${trip_id}.`,
      { trip_id },
    );
  }
  return t;
}

/**
 * Legal per-leg transitions. Keep narrow — any move not listed is a
 * bug, not a feature. In particular:
 *
 *   - `pending` can advance to `in_flight` (start dispatch) or `failed`
 *     (preflight abort, e.g. router found no healthy agent).
 *   - `in_flight` can only settle to `committed` or `failed`.
 *   - `committed` can move to `rolled_back` (cancel succeeded) or
 *     `rollback_failed` (cancel itself errored).
 *   - `rollback_failed` can retry to `rolled_back` (saga idempotency
 *     path) but not back to `committed` — once cancel was attempted,
 *     the vendor-side booking state is ambiguous.
 *   - `failed` and `rolled_back` are terminal.
 */
function isLegalLegTransition(from: LegExecutionStatus, to: LegExecutionStatus): boolean {
  if (from === to) return true; // idempotent self-updates are fine
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
