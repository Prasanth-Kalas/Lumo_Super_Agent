import {
  replayCompoundTransaction,
  type CompoundLegSnapshot,
  type CompoundReplayAction,
  type CompoundReplayPlan,
  type CompoundTransactionReplaySnapshot,
} from "../saga.js";
import {
  buildLegStatusFrame,
  type LegStatusFrameV2,
} from "../sse/leg-status.js";

export interface CompoundLegExecutionResult {
  ok: boolean;
  provider_reference?: string;
  evidence?: Record<string, unknown>;
  error_code?: string;
}

export interface CompoundGraphRunnerOptions {
  snapshot: CompoundTransactionReplaySnapshot;
  executeLeg: (leg: CompoundLegSnapshot) => Promise<CompoundLegExecutionResult>;
  compensateLeg: (leg: CompoundLegSnapshot) => Promise<CompoundLegExecutionResult>;
  emit?: (frame: LegStatusFrameV2) => void | Promise<void>;
  maxIterations?: number;
}

export interface CompoundGraphRunnerResult {
  snapshot: CompoundTransactionReplaySnapshot;
  replay_plan: CompoundReplayPlan;
  emitted: LegStatusFrameV2[];
}

const DEFAULT_MAX_ITERATIONS = 50;

/**
 * Runs a compound transaction graph to the next terminal state.
 *
 * Cycle prevention doctrine: callers must run the saga replay planner before
 * dependency INSERT and reject invalid graphs. This runner still checks every
 * loaded snapshot defensively so a malformed ledger snapshot goes to
 * manual_review instead of executing money-moving legs.
 */
export async function runCompoundGraph(
  options: CompoundGraphRunnerOptions,
): Promise<CompoundGraphRunnerResult> {
  const state = cloneSnapshot(options.snapshot);
  const emitted: LegStatusFrameV2[] = [];
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let replayPlan = replayCompoundTransaction(state);

  const emit = async (
    leg: CompoundLegSnapshot,
    status: LegStatusFrameV2["status"],
    result?: CompoundLegExecutionResult,
  ) => {
    const frame = buildLegStatusFrame({
      leg_id: leg.leg_id,
      transaction_id: leg.transaction_id,
      agent_id: leg.agent_id,
      capability_id: leg.capability_id,
      status,
      provider_reference: result?.provider_reference ?? leg.provider_reference ?? undefined,
      evidence: result?.evidence,
      timestamp: new Date().toISOString(),
    });
    emitted.push(frame);
    await options.emit?.(frame);
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (!replayPlan.graph_valid) {
      state.status = "manual_review";
      break;
    }

    const actions = replayPlan.next_actions;
    if (actions.length === 0) break;
    const kind = actions[0]?.kind;

    if (actions.every((action) => action.kind === "execute_leg")) {
      await Promise.all(actions.map((action) => executeForwardAction(action, state, options.executeLeg, emit)));
    } else if (actions.every((action) => action.kind === "dispatch_compensation")) {
      state.status = "rolling_back";
      await Promise.all(actions.map((action) => executeCompensationAction(action, state, options.compensateLeg, emit)));
    } else if (kind === "mark_committed") {
      state.status = "committed";
      break;
    } else if (kind === "mark_rolled_back") {
      state.status = "rolled_back";
      break;
    } else if (kind === "mark_manual_review") {
      state.status = "manual_review";
      markActionLegManual(actions, state);
      break;
    } else if (kind === "wait_for_in_flight" || kind === "noop") {
      break;
    } else {
      state.status = "manual_review";
      break;
    }

    replayPlan = replayCompoundTransaction(state);
    if (isTerminal(state.status)) break;
  }

  replayPlan = replayCompoundTransaction(state);
  return { snapshot: state, replay_plan: replayPlan, emitted };
}

async function executeForwardAction(
  action: CompoundReplayAction,
  state: CompoundTransactionReplaySnapshot,
  executeLeg: CompoundGraphRunnerOptions["executeLeg"],
  emit: (
    leg: CompoundLegSnapshot,
    status: LegStatusFrameV2["status"],
    result?: CompoundLegExecutionResult,
  ) => Promise<void>,
): Promise<void> {
  const leg = requireActionLeg(action, state);
  leg.status = "in_flight";
  state.status = "executing";
  await emit(leg, "in_flight");

  const result = await settleLeg(() => executeLeg(leg));
  if (result.ok) {
    leg.status = "committed";
    leg.provider_reference = result.provider_reference ?? leg.provider_reference;
    await emit(leg, "committed", result);
    return;
  }

  leg.status = "failed";
  state.status = state.failure_policy === "manual_review" ? "manual_review" : "rolling_back";
  await emit(leg, "failed", result);
}

async function executeCompensationAction(
  action: CompoundReplayAction,
  state: CompoundTransactionReplaySnapshot,
  compensateLeg: CompoundGraphRunnerOptions["compensateLeg"],
  emit: (
    leg: CompoundLegSnapshot,
    status: LegStatusFrameV2["status"],
    result?: CompoundLegExecutionResult,
  ) => Promise<void>,
): Promise<void> {
  const leg = requireActionLeg(action, state);
  leg.status = "rollback_in_flight";
  await emit(leg, "rollback_pending");

  const result = await settleLeg(() => compensateLeg(leg));
  if (result.ok) {
    leg.status = "rolled_back";
    await emit(leg, "rolled_back", result);
    return;
  }

  leg.status = "rollback_failed";
  state.status = "manual_review";
  await emit(leg, "rollback_failed", result);
}

async function settleLeg(
  run: () => Promise<CompoundLegExecutionResult>,
): Promise<CompoundLegExecutionResult> {
  try {
    return await run();
  } catch (error) {
    return {
      ok: false,
      error_code: error instanceof Error ? error.message : "leg_execution_failed",
    };
  }
}

function requireActionLeg(
  action: CompoundReplayAction,
  state: CompoundTransactionReplaySnapshot,
): CompoundLegSnapshot {
  const leg = state.legs.find((row) => row.leg_id === action.leg_id);
  if (!leg) throw new Error(`compound_action_leg_missing:${action.leg_id ?? "<none>"}`);
  return leg;
}

function markActionLegManual(
  actions: CompoundReplayAction[],
  state: CompoundTransactionReplaySnapshot,
) {
  for (const action of actions) {
    if (!action.leg_id) continue;
    const leg = state.legs.find((row) => row.leg_id === action.leg_id);
    if (leg) leg.status = "manual_review";
  }
}

function cloneSnapshot(
  snapshot: CompoundTransactionReplaySnapshot,
): CompoundTransactionReplaySnapshot {
  return {
    ...snapshot,
    legs: snapshot.legs.map((leg) => ({
      ...leg,
      depends_on: leg.depends_on.slice(),
    })),
  };
}

function isTerminal(status: CompoundTransactionReplaySnapshot["status"]): boolean {
  return ["committed", "rolled_back", "failed", "manual_review", "cancelled"].includes(status);
}
