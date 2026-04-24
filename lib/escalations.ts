/**
 * Escalation queue.
 *
 * When Saga compensation fails (a cancel tool errors, a leg has no
 * booking_id so we can't address the vendor side, a manual-only leg
 * was encountered), the trip ends up in `rollback_failed` and the
 * user has been charged without a reliable path to a refund. Without
 * this table those trips would sit silently — worst-case outcome.
 *
 * This module is a narrow write+read surface. We don't implement
 * claim/assign/workflow here — that's an admin UI problem; the DB
 * row IS the queue.
 *
 * Graceful fallback: in in-memory mode (no Supabase env) we log a
 * warning per unresolved escalation so the dev at least sees
 * something. Not a production substitute — ops can't query logs.
 */

import crypto from "node:crypto";
import { getSupabase } from "./db.js";

export type EscalationReason =
  | "rollback_failed"        // cancel tool errored
  | "missing_booking_id"     // leg committed without an addressable id
  | "no_compensation_tool"   // agent declares no cancel counterpart
  | "price_integrity_violation" // overcharge + rollback also failed
  | "manual_only";           // saga flagged as needing human

export interface OpenEscalationInput {
  trip_id: string;
  session_id?: string | null;
  user_id?: string | null;
  leg_order?: number | null;
  reason: EscalationReason;
  detail?: Record<string, unknown>;
}

export interface EscalationRow {
  escalation_id: string;
  trip_id: string;
  session_id: string | null;
  user_id: string | null;
  leg_order: number | null;
  reason: string;
  detail: Record<string, unknown>;
  status: "open" | "investigating" | "resolved";
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
}

function mintEscalationId(): string {
  // Short, URL-safe, ordered-ish (timestamp prefix) so a support
  // engineer can eyeball when this fired.
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `esc_${ts}_${rand}`;
}

/**
 * File an escalation. Fire-and-forget — we never want to throw out
 * of the rollback path and leave a leg in a weird state just because
 * the escalation insert failed. If Supabase is unavailable we log
 * loudly so the operator at least sees the warning in function logs.
 */
export async function openEscalation(
  input: OpenEscalationInput,
): Promise<{ escalation_id: string | null }> {
  const escalation_id = mintEscalationId();

  const db = getSupabase();
  if (!db) {
    console.warn(
      "[escalations] UNPERSISTED escalation — Supabase not configured. " +
        "Log this somewhere retrievable:",
      {
        escalation_id,
        trip_id: input.trip_id,
        reason: input.reason,
        leg_order: input.leg_order,
        detail: input.detail,
      },
    );
    return { escalation_id: null };
  }

  const row = {
    escalation_id,
    trip_id: input.trip_id,
    session_id: input.session_id ?? null,
    user_id: input.user_id ?? null,
    leg_order: input.leg_order ?? null,
    reason: input.reason,
    detail: input.detail ?? {},
    status: "open" as const,
  };

  const { error } = await db.from("escalations").insert(row);
  if (error) {
    console.error(
      "[escalations] insert failed (non-fatal):",
      error.message,
      { escalation_id, trip_id: input.trip_id, reason: input.reason },
    );
    return { escalation_id: null };
  }
  return { escalation_id };
}

/**
 * Read open escalations, oldest first. Default limit 100 — ops
 * typically paginates. Optional `user_id` filter for per-user
 * "what's still open for me".
 */
export async function listOpenEscalations(opts?: {
  user_id?: string;
  limit?: number;
}): Promise<EscalationRow[]> {
  const db = getSupabase();
  if (!db) return [];

  let q = db
    .from("escalations")
    .select(
      "escalation_id, trip_id, session_id, user_id, leg_order, reason, detail, status, resolution_notes, created_at, updated_at",
    )
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(opts?.limit ?? 100);

  if (opts?.user_id) q = q.eq("user_id", opts.user_id);

  const { data, error } = await q;
  if (error) {
    console.error("[escalations] list failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as EscalationRow[];
}
