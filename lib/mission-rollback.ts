import { getSupabase } from "./db.ts";
import {
  rollbackActionForStep,
  rollbackCompleteFromSteps,
  rollbackStartedPayload,
  rollbackStepAlreadyTerminal,
  rollbackStepPayload,
  rollbackTransition,
  type RollbackEventRow,
  type RollbackMissionRow,
  type RollbackStepRow,
  type RollbackTrigger,
} from "./mission-rollback-core.ts";
import { recordExecutionEvent } from "./mission-execution.ts";
import { hashPayload } from "./mission-executor-core.ts";
import type { AgentError } from "@lumo/agent-sdk";
import type { MissionState } from "./mission-execution-core.ts";

interface SupabaseLike {
  from(table: string): any;
  rpc?(fn: string, args?: Record<string, unknown>): any;
}

export interface MissionRollbackCounts extends Record<string, number> {
  disabled: number;
  claimed: number;
  compensated: number;
  skipped: number;
  failed: number;
  rollback_completed: number;
}

export interface MissionRollbackResult {
  ok: boolean;
  counts: MissionRollbackCounts;
  errors: string[];
}

export type RollbackToolDispatcher = (
  toolName: string,
  args: Record<string, unknown>,
  step: RollbackStepRow,
) => Promise<
  | { ok: true; result: unknown; latency_ms: number }
  | { ok: false; error: Pick<AgentError, "code" | "message" | "detail">; latency_ms: number }
>;

export async function initiateMissionRollback(args: {
  mission_id: string;
  trigger: RollbackTrigger;
  reason?: string | null;
  actor_user_id?: string | null;
  force?: boolean;
  user_id?: string | null;
  db?: SupabaseLike | null;
}): Promise<{ ok: boolean; mission_id: string; state?: MissionState; reason?: string }> {
  const db = (args.db ?? getSupabase()) as SupabaseLike | null;
  if (!db) return { ok: false, mission_id: args.mission_id, reason: "supabase_not_configured" };

  const mission = await readMission(db, args.mission_id);
  if (!mission) return { ok: false, mission_id: args.mission_id, reason: "mission_not_found" };
  if (args.user_id && mission.user_id !== args.user_id) {
    return { ok: false, mission_id: args.mission_id, reason: "mission_not_found" };
  }

  const transition = rollbackTransition(mission.state, {
    trigger: args.trigger,
    force: args.force === true,
  });
  if (!transition.ok || !transition.target) {
    return {
      ok: false,
      mission_id: args.mission_id,
      state: mission.state,
      reason: transition.reason,
    };
  }

  if (mission.state !== transition.target) {
    await updateMissionState(db, args.mission_id, transition.target);
  }

  const events = await readMissionEvents(db, args.mission_id);
  if (!events.some((event) => event.event_type === "rollback_initiated")) {
    await recordExecutionEvent(
      {
        mission_id: args.mission_id,
        event_type: "rollback_initiated",
        payload: rollbackStartedPayload({
          trigger: args.trigger,
          actor_user_id: args.actor_user_id ?? null,
          reason: args.reason ?? null,
        }),
      },
      { db },
    );
  }

  let finalState = transition.target;
  if (transition.target === "rolled_back") {
    await recordRollbackCompletedIfNeeded(db, args.mission_id, {
      forward_steps: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    });
  } else if (transition.target === "rolling_back") {
    const completed = await finishMissionRollbackIfComplete(db, args.mission_id);
    if (completed) finalState = "rolled_back";
  }

  return { ok: true, mission_id: args.mission_id, state: finalState };
}

export async function runMissionRollbackTick(options: {
  db?: SupabaseLike | null;
  limit?: number;
  dispatchTool?: RollbackToolDispatcher;
} = {}): Promise<MissionRollbackResult> {
  const db = (options.db ?? getSupabase()) as SupabaseLike | null;
  const counts: MissionRollbackCounts = {
    disabled: 0,
    claimed: 0,
    compensated: 0,
    skipped: 0,
    failed: 0,
    rollback_completed: 0,
  };
  const errors: string[] = [];
  if (!db) return { ok: false, counts, errors: ["supabase_not_configured"] };

  const dispatchTool = options.dispatchTool ?? dispatchRollbackTool;
  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 10)));

  while (counts.claimed < limit) {
    const steps = await claimRollbackSteps(db, 1);
    if (steps.length === 0) {
      counts.rollback_completed += await finishIdleRollingBackMissions(db, limit);
      break;
    }
    const step = steps[0];
    if (!step) break;
    counts.claimed += 1;
    try {
      const events = await readMissionEvents(db, step.mission_id);
      if (rollbackStepAlreadyTerminal(step.id, events)) {
        counts.skipped += 1;
        continue;
      }

      const action = rollbackActionForStep(step, events);
      if (action.kind === "skip") {
        await finishRollbackAttempt(db, step.id, "skipped", action.reason);
        await recordExecutionEvent(
          {
            mission_id: step.mission_id,
            step_id: step.id,
            event_type: "rollback_step_skipped",
            payload: rollbackStepPayload(step, { reason: action.reason }),
          },
          { db },
        );
        if (action.reason === "reversible_noop") {
          await updateMissionStep(db, step.id, {
            status: "rolled_back",
            finished_at: new Date().toISOString(),
          });
        }
        counts.skipped += 1;
      } else {
        await startRollbackAttempt(db, step, action.tool_name, action.inputs);
        await recordExecutionEvent(
          {
            mission_id: step.mission_id,
            step_id: step.id,
            event_type: "rollback_step_started",
            payload: rollbackStepPayload(step, {
              compensating_tool: action.tool_name,
              inputs_hash: hashPayload(action.inputs),
            }),
          },
          { db },
        );
        const result = await dispatchTool(action.tool_name, action.inputs, step);
        if (result.ok) {
          await finishRollbackAttempt(db, step.id, "succeeded", null);
          await updateMissionStep(db, step.id, {
            status: "rolled_back",
            error_text: null,
            finished_at: new Date().toISOString(),
          });
          await recordExecutionEvent(
            {
              mission_id: step.mission_id,
              step_id: step.id,
              event_type: "rollback_step_succeeded",
              payload: rollbackStepPayload(step, {
                compensating_tool: action.tool_name,
                latency_ms: result.latency_ms,
                outputs_hash: hashPayload(result.result),
              }),
            },
            { db },
          );
          counts.compensated += 1;
        } else {
          await finishRollbackAttempt(db, step.id, "failed", result.error.message);
          await updateMissionStep(db, step.id, {
            status: "rollback_failed",
            error_text: result.error.message,
            finished_at: new Date().toISOString(),
          });
          await recordExecutionEvent(
            {
              mission_id: step.mission_id,
              step_id: step.id,
              event_type: "rollback_step_failed",
              payload: rollbackStepPayload(step, {
                compensating_tool: action.tool_name,
                error_code: result.error.code,
                error_text: result.error.message,
                latency_ms: result.latency_ms,
              }),
            },
            { db },
          );
          counts.failed += 1;
          errors.push(`rollback_step_failed:${step.id}:${result.error.code}`);
        }
      }

      const completed = await finishMissionRollbackIfComplete(db, step.mission_id);
      if (completed) counts.rollback_completed += 1;
    } catch (err) {
      counts.failed += 1;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { ok: errors.length === 0, counts, errors };
}

async function finishIdleRollingBackMissions(
  db: SupabaseLike,
  limit: number,
): Promise<number> {
  const missions = await readRollingBackMissions(db, limit);
  let completed = 0;
  for (const mission of missions) {
    if (await finishMissionRollbackIfComplete(db, mission.id)) completed += 1;
  }
  return completed;
}

async function dispatchRollbackTool(
  toolName: string,
  args: Record<string, unknown>,
  step: RollbackStepRow,
) {
  const { dispatchToolCall } = await import("./router.ts");
  return dispatchToolCall(toolName, args, {
    user_id: step.user_id ?? "anon",
    session_id: `mission:${step.mission_id}:rollback`,
    turn_id: `mission-rollback:${step.id}`,
    idempotency_key: `mission:${step.mission_id}:${step.id}:rollback`,
    region: "US",
    device_kind: "web",
    prior_summary: null,
    user_confirmed: true,
    user_pii: {},
  });
}

async function claimRollbackSteps(
  db: SupabaseLike,
  limit: number,
): Promise<RollbackStepRow[]> {
  if (typeof db.rpc !== "function") throw new Error("mission_rollback_rpc_unavailable");
  const { data, error } = await db.rpc("next_rollback_step_for_execution", {
    requested_limit: Math.max(1, Math.min(10, Math.trunc(limit))),
  });
  if (error) throw new Error(`rollback_step_claim_failed:${error.message ?? "unknown"}`);
  return Array.isArray(data)
    ? data.map(normalizeRollbackStep).filter((row): row is RollbackStepRow => row !== null)
    : [];
}

async function readMission(db: SupabaseLike, mission_id: string): Promise<RollbackMissionRow | null> {
  const { data, error } = await db
    .from("missions")
    .select("id, user_id, state")
    .eq("id", mission_id)
    .limit(1);
  if (error) throw new Error(`mission_read_failed:${error.message ?? "unknown"}`);
  return normalizeMissionRow(Array.isArray(data) ? data[0] : null);
}

async function readRollingBackMissions(
  db: SupabaseLike,
  limit: number,
): Promise<RollbackMissionRow[]> {
  const { data, error } = await db
    .from("missions")
    .select("id, user_id, state")
    .eq("state", "rolling_back")
    .limit(Math.max(1, Math.min(10, Math.trunc(limit))));
  if (error) throw new Error(`rolling_back_missions_read_failed:${error.message ?? "unknown"}`);
  return Array.isArray(data)
    ? data.map(normalizeMissionRow).filter((row): row is RollbackMissionRow => row !== null)
    : [];
}

async function readMissionSteps(db: SupabaseLike, mission_id: string): Promise<RollbackStepRow[]> {
  const { data, error } = await db
    .from("mission_steps")
    .select("id, mission_id, step_order, agent_id, tool_name, reversibility, status, inputs, outputs, finished_at, confirmation_card_id")
    .eq("mission_id", mission_id);
  if (error) throw new Error(`mission_steps_read_failed:${error.message ?? "unknown"}`);
  return Array.isArray(data)
    ? data.map(normalizeRollbackStep).filter((row): row is RollbackStepRow => row !== null)
    : [];
}

async function readMissionEvents(db: SupabaseLike, mission_id: string): Promise<RollbackEventRow[]> {
  const { data, error } = await db
    .from("mission_execution_events")
    .select("mission_id, step_id, event_type, payload, created_at")
    .eq("mission_id", mission_id)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`mission_events_read_failed:${error.message ?? "unknown"}`);
  return Array.isArray(data) ? data.map(normalizeEventRow) : [];
}

async function updateMissionState(
  db: SupabaseLike,
  mission_id: string,
  state: MissionState,
): Promise<void> {
  const { error } = await db.from("missions").update({ state }).eq("id", mission_id);
  if (error) throw new Error(`mission_update_failed:${error.message ?? "unknown"}`);
}

async function updateMissionStep(
  db: SupabaseLike,
  step_id: string,
  update: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("mission_steps").update(update).eq("id", step_id);
  if (error) throw new Error(`mission_step_update_failed:${error.message ?? "unknown"}`);
}

async function startRollbackAttempt(
  db: SupabaseLike,
  step: RollbackStepRow,
  compensating_tool: string,
  rendered_inputs: Record<string, unknown>,
): Promise<void> {
  const row = {
    mission_id: step.mission_id,
    step_id: step.id,
    attempt: 1,
    compensating_tool,
    rendered_inputs,
    status: "running",
  };
  const table = db.from("mission_step_rollback_attempts") as {
    upsert?: (
      values: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<{ error: { message?: string } | null }>;
    insert?: (values: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>;
  };
  if (typeof table.upsert === "function") {
    const { error } = await table.upsert(row, { onConflict: "step_id,attempt" });
    if (error) throw new Error(`rollback_attempt_upsert_failed:${error.message ?? "unknown"}`);
    return;
  }
  const { error } = await table.insert?.(row) ?? { error: { message: "missing_insert" } };
  if (error && !String(error.message ?? "").includes("duplicate")) {
    throw new Error(`rollback_attempt_insert_failed:${error.message ?? "unknown"}`);
  }
}

async function finishRollbackAttempt(
  db: SupabaseLike,
  step_id: string,
  status: "succeeded" | "failed" | "skipped",
  error_text: string | null,
): Promise<void> {
  const { error } = await db
    .from("mission_step_rollback_attempts")
    .update({
      status,
      error_text,
      finished_at: new Date().toISOString(),
    })
    .eq("step_id", step_id)
    .eq("attempt", 1);
  if (error) throw new Error(`rollback_attempt_update_failed:${error.message ?? "unknown"}`);
}

async function finishMissionRollbackIfComplete(
  db: SupabaseLike,
  mission_id: string,
): Promise<boolean> {
  const steps = await readMissionSteps(db, mission_id);
  const events = await readMissionEvents(db, mission_id);
  const completion = rollbackCompleteFromSteps(steps, events);
  if (!completion.complete || completion.failed) return false;
  await updateMissionState(db, mission_id, "rolled_back");
  await recordRollbackCompletedIfNeeded(db, mission_id, completion.counts);
  return true;
}

async function recordRollbackCompletedIfNeeded(
  db: SupabaseLike,
  mission_id: string,
  counts: Record<string, number>,
): Promise<void> {
  const events = await readMissionEvents(db, mission_id);
  if (events.some((event) => event.event_type === "rollback_completed")) return;
  await recordExecutionEvent(
    {
      mission_id,
      event_type: "rollback_completed",
      payload: counts,
    },
    { db },
  );
}

function normalizeMissionRow(row: unknown): RollbackMissionRow | null {
  if (!isRecord(row)) return null;
  const id = stringOrNull(row.id);
  const state = stringOrNull(row.state);
  if (!id || !isMissionState(state)) return null;
  return {
    id,
    user_id: stringOrNull(row.user_id),
    state,
  };
}

function normalizeRollbackStep(row: unknown): RollbackStepRow | null {
  if (!isRecord(row)) return null;
  const id = stringOrNull(row.id);
  const mission_id = stringOrNull(row.mission_id);
  const agent_id = stringOrNull(row.agent_id);
  const tool_name = stringOrNull(row.tool_name);
  if (!id || !mission_id || !agent_id || !tool_name) return null;
  return {
    id,
    mission_id,
    user_id: stringOrNull(row.user_id) ?? undefined,
    step_order: numberOrZero(row.step_order),
    agent_id,
    tool_name,
    reversibility: stringOrNull(row.reversibility) ?? "reversible",
    status: stringOrNull(row.status) ?? "succeeded",
    inputs: isRecord(row.inputs) ? row.inputs : {},
    outputs: isRecord(row.outputs) ? row.outputs : {},
    finished_at: stringOrNull(row.finished_at),
    confirmation_card_id: stringOrNull(row.confirmation_card_id),
  };
}

function normalizeEventRow(row: unknown): RollbackEventRow {
  const r = isRecord(row) ? row : {};
  return {
    mission_id: stringOrNull(r.mission_id),
    step_id: stringOrNull(r.step_id),
    event_type: stringOrNull(r.event_type) ?? "",
    payload: isRecord(r.payload) ? r.payload : {},
    created_at: stringOrNull(r.created_at),
  };
}

function isMissionState(input: unknown): input is MissionState {
  return [
    "draft",
    "awaiting_permissions",
    "awaiting_user_input",
    "ready",
    "executing",
    "awaiting_confirmation",
    "rolling_back",
    "completed",
    "failed",
    "rolled_back",
  ].includes(String(input));
}

function stringOrNull(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input : null;
}

function numberOrZero(input: unknown): number {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
