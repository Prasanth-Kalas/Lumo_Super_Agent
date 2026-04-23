/**
 * Saga — compound-booking rollback planner.
 *
 * This module is PURE. It has no network, no timers, no logging — it
 * takes a snapshot of a trip's execution state and returns a plan the
 * orchestrator should enact. Keeping it side-effect-free is what lets
 * us smoke-test Saga behaviour in-memory against fixtures.
 *
 * Why not just loop through committed legs in reverse and call each
 * cancel tool? Three reasons:
 *
 *   1. **Reverse-topological, not reverse-order.** A trip's legs form a
 *      DAG via `depends_on`. Two independent legs may have committed in
 *      parallel; when rolling back, we must not cancel a prerequisite
 *      before its dependents. (Concrete example: if `hotel` depends on
 *      `flight`, cancelling `flight` first could trip downstream vendor
 *      logic that auto-cancels the hotel under vendor-specific rules —
 *      which we then try to cancel again via our own Saga, racing the
 *      vendor.) Reverse-topological order respects the DAG.
 *
 *   2. **Compensation-kind awareness.** Not every cancel fully reverses
 *      the forward action. The SDK classifies three kinds:
 *        - `perfect`     — reversal is complete (hold release, etc.)
 *        - `best-effort` — vendor may refuse or partial-refund
 *        - `manual`      — cancel tool exists but expects human follow-up
 *      For `manual` legs the Saga should NOT attempt an automated call;
 *      those escalate straight to the user/ops team. For `best-effort`
 *      the Saga calls but tracks residual exposure.
 *
 *   3. **Idempotency guarantee.** If a rollback attempt itself fails
 *      mid-sequence, the next attempt needs to resume, not restart. The
 *      plan is deterministic given the same snapshot — calling
 *      `planRollback` twice on the same state yields byte-identical
 *      output. The orchestrator can therefore cache the plan, retry
 *      individual steps, and re-plan safely after each step's outcome.
 *
 * What this module does NOT do: actually dispatch the cancel calls, or
 * persist state, or talk to Anthropic. The orchestrator's saga-executor
 * (follow-up task) consumes the plan returned here.
 */

import type { ToolRoutingEntry } from "@lumo/agent-sdk";

// ──────────────────────────────────────────────────────────────────────────
// Input — what the orchestrator knows at rollback decision time
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-leg execution status. The orchestrator's saga-executor updates
 * this as it makes forward progress; the Saga reads the final snapshot.
 */
export type LegExecutionStatus =
  | "pending"        // forward tool not yet dispatched
  | "in_flight"      // forward tool dispatched, awaiting result
  | "committed"      // forward tool returned 2xx (money moved)
  | "failed"         // forward tool returned error
  | "rolled_back"    // committed, then cancel tool ran to completion
  | "rollback_failed"; // committed, cancel tool attempted but itself failed

export interface LegExecutionSnapshot {
  /** Matches TripLegRef.order (1-indexed, dense). */
  order: number;
  /** Matches TripLegRef.agent_id. */
  agent_id: string;
  /** Forward bookable tool name (e.g. flight_book_offer). */
  tool_name: string;
  /** Legs this leg depends on (order values). */
  depends_on: number[];
  /** Current status as of the snapshot time. */
  status: LegExecutionStatus;
  /**
   * Only set when status is `committed` or `rollback_failed`. The
   * cancel dispatch uses this as its `booking_id` parameter.
   *
   * The booking_id must come from the forward tool's response body —
   * the Saga does NOT try to derive it from session state or guess.
   */
  booking_id?: string;
  /**
   * Free-form error context captured from the forward tool's failure
   * (if status === "failed") or the cancel tool's failure (if status
   * === "rollback_failed"). Used for audit only.
   */
  error_detail?: Record<string, unknown>;
}

/**
 * What the planner needs to resolve cancel tool names, compensation
 * kinds, and HTTP paths for each committed leg.
 */
export interface RoutingLookup {
  /** Full routing map keyed by tool_name. */
  routing: Record<string, ToolRoutingEntry>;
}

// ──────────────────────────────────────────────────────────────────────────
// Output — the plan the orchestrator's saga-executor walks
// ──────────────────────────────────────────────────────────────────────────

/**
 * One step in the rollback plan. The orchestrator dispatches these in
 * the order emitted — each step is an independent tool call whose
 * result feeds back into the execution snapshot for the next plan.
 */
export interface RollbackStep {
  /** Leg being compensated. */
  order: number;
  /** Cancel tool to invoke. */
  tool_name: string;
  /** Agent that owns the cancel tool. Matches the forward leg's agent. */
  agent_id: string;
  /** Body the cancel tool expects. booking_id is required; reason is audit. */
  body: {
    booking_id: string;
    reason: string;
  };
  /** How authoritative the reversal is. Drives user-facing messaging. */
  compensation_kind: "perfect" | "best-effort" | "manual";
}

/**
 * Legs the Saga refuses to auto-compensate — they require human
 * follow-up. The orchestrator should surface these to the user AND to
 * ops simultaneously; the user shouldn't discover unexpected charges,
 * and ops needs the audit trail.
 */
export interface ManualEscalation {
  order: number;
  tool_name: string; // forward tool that committed
  agent_id: string;
  booking_id: string;
  reason:
    | "compensation_kind_manual" // cancel tool exists but is marked manual
    | "no_cancel_tool"           // forward tool has no `cancels` link (shouldn't happen post-#28)
    | "cancel_tool_missing"      // `cancels` points at a tool not in the routing map
    | "missing_booking_id";      // committed leg has no booking_id — orchestrator forward-pass bug
}

export interface RollbackPlan {
  /** Steps in the order the orchestrator should attempt them. */
  steps: RollbackStep[];
  /** Legs that cannot be auto-compensated and need human intervention. */
  manual_escalations: ManualEscalation[];
  /**
   * Optimistic total refund amount if every best-effort/perfect step
   * succeeds at face value. Undefined if any committed leg has unknown
   * refund terms. Informational only — actual refund comes from vendor.
   */
  expected_refund_legs: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Planner
// ──────────────────────────────────────────────────────────────────────────

/**
 * Given the current execution snapshot, produce the rollback plan.
 *
 * Inputs:
 *   - `legs`: every leg the orchestrator has touched this turn. Must
 *     include legs in every status — the planner needs to see `failed`
 *     and `in_flight` legs to know which *committed* legs need rollback.
 *   - `lookup`: routing map so we can resolve cancel tools.
 *
 * The planner:
 *   1. Collects every leg in status `committed` or `rollback_failed`
 *      (the latter so retries produce the same plan).
 *   2. Orders them reverse-topologically — a leg that depends on
 *      another is cancelled before its prerequisite.
 *   3. Resolves each to its cancel tool via routing, classifying
 *      compensation_kind.
 *   4. Emits steps for perfect/best-effort, escalations for manual.
 *
 * Determinism: given the same `legs` and `lookup`, this function
 * returns byte-identical output. Callers can therefore cache plans.
 *
 * Complexity: O(N) for N legs — the topo sort is over dependency
 * edges, which are already cheap (each leg's depends_on list is small).
 */
export function planRollback(
  legs: LegExecutionSnapshot[],
  lookup: RoutingLookup,
): RollbackPlan {
  // 1. Pick legs that committed (or whose rollback previously failed).
  const needsRollback = legs.filter(
    (l) => l.status === "committed" || l.status === "rollback_failed",
  );

  // 2. Reverse-topological order. A leg with higher order that depends
  //    on a leg with lower order must come FIRST in the rollback.
  //
  //    Simple approach: sort by (max depth in DAG, order desc). Depth
  //    is the longest path from a leg to the root set — legs at depth
  //    3 roll back before depth 2 before depth 1.
  const depthByOrder = computeDepths(legs);
  const sorted = needsRollback.slice().sort((a, b) => {
    const da = depthByOrder.get(a.order) ?? 0;
    const db = depthByOrder.get(b.order) ?? 0;
    if (da !== db) return db - da; // deeper first
    return b.order - a.order;      // stable tiebreak: later-ordered first
  });

  const steps: RollbackStep[] = [];
  const manual_escalations: ManualEscalation[] = [];

  for (const leg of sorted) {
    if (!leg.booking_id) {
      // This is a bug in the orchestrator's forward pass, not a user-
      // recoverable state — the leg is marked committed but we have no
      // booking_id to cancel against. Escalate rather than swallow.
      manual_escalations.push({
        order: leg.order,
        tool_name: leg.tool_name,
        agent_id: leg.agent_id,
        booking_id: "<unknown>",
        reason: "missing_booking_id",
      });
      continue;
    }

    const forwardRouting = lookup.routing[leg.tool_name];
    if (!forwardRouting || !forwardRouting.cancels) {
      manual_escalations.push({
        order: leg.order,
        tool_name: leg.tool_name,
        agent_id: leg.agent_id,
        booking_id: leg.booking_id,
        reason: "no_cancel_tool",
      });
      continue;
    }

    const cancelRouting = lookup.routing[forwardRouting.cancels];
    if (!cancelRouting) {
      manual_escalations.push({
        order: leg.order,
        tool_name: leg.tool_name,
        agent_id: leg.agent_id,
        booking_id: leg.booking_id,
        reason: "cancel_tool_missing",
      });
      continue;
    }

    const kind = cancelRouting.compensation_kind ?? "best-effort";

    if (kind === "manual") {
      manual_escalations.push({
        order: leg.order,
        tool_name: leg.tool_name,
        agent_id: leg.agent_id,
        booking_id: leg.booking_id,
        reason: "compensation_kind_manual",
      });
      continue;
    }

    steps.push({
      order: leg.order,
      tool_name: forwardRouting.cancels,
      agent_id: cancelRouting.agent_id,
      body: {
        booking_id: leg.booking_id,
        reason: buildReason(leg, legs),
      },
      compensation_kind: kind,
    });
  }

  return {
    steps,
    manual_escalations,
    expected_refund_legs: steps.filter(
      (s) => s.compensation_kind === "perfect" || s.compensation_kind === "best-effort",
    ).length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute each leg's depth in the dependency DAG. Leg with no
 * dependencies is depth 0. A leg that depends on depth-0 legs is
 * depth 1. And so on. Used for reverse-topological ordering.
 *
 * We compute depth for ALL legs (not just committed ones) because a
 * committed leg's depth is influenced by the legs it depends on even
 * if those prerequisites are in other states.
 */
function computeDepths(legs: LegExecutionSnapshot[]): Map<number, number> {
  const byOrder = new Map<number, LegExecutionSnapshot>();
  for (const l of legs) byOrder.set(l.order, l);

  const depths = new Map<number, number>();
  function depth(order: number, seen: Set<number>): number {
    if (depths.has(order)) return depths.get(order)!;
    if (seen.has(order)) {
      // Cyclic dependency — shouldn't happen (TripSummary validator
      // enforces `depends_on[i] < order`), but guard against it rather
      // than recurse forever.
      return 0;
    }
    const leg = byOrder.get(order);
    if (!leg || leg.depends_on.length === 0) {
      depths.set(order, 0);
      return 0;
    }
    const next = new Set(seen);
    next.add(order);
    let d = 0;
    for (const dep of leg.depends_on) {
      d = Math.max(d, depth(dep, next) + 1);
    }
    depths.set(order, d);
    return d;
  }

  for (const l of legs) depth(l.order, new Set());
  return depths;
}

/**
 * Build the audit `reason` string for a rollback step. Stable and
 * human-readable — shows up in agent-side logs and ops dashboards.
 *
 * Format: `trip_rollback:<failure-site>` where failure-site is the
 * order of the leg that tripped the rollback, or "user_abort" if no
 * leg has status=failed but we're rolling back anyway (e.g. user
 * cancels after a partial commit — rare but possible).
 */
function buildReason(
  _leg: LegExecutionSnapshot,
  allLegs: LegExecutionSnapshot[],
): string {
  const failed = allLegs.find((l) => l.status === "failed");
  if (failed) return `trip_rollback:leg_${failed.order}_${failed.tool_name}_failed`;
  return "trip_rollback:user_abort";
}
