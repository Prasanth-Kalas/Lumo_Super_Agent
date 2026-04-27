import { getSupabase } from "./db.ts";
import {
  hashPayload,
  isRetryableDispatchFailure,
  missionCompletionFromStatuses,
  stepFailedPayload,
  stepStartedPayload,
  stepSucceededPayload,
  type ClaimedMissionStep,
  type MissionDispatchResult,
} from "./mission-executor-core.ts";
import type { MissionState, MissionStepStatus } from "./mission-execution-core.ts";
import { recordExecutionEvent } from "./mission-execution.ts";

interface SupabaseLike {
  from(table: string): any;
  rpc?(fn: string, args?: Record<string, unknown>): any;
}

export interface MissionExecutorCounts extends Record<string, number> {
  disabled: number;
  claimed: number;
  succeeded: number;
  failed: number;
  mission_completed: number;
  mission_failed: number;
}

export interface MissionExecutorResult {
  ok: boolean;
  counts: MissionExecutorCounts;
  errors: string[];
}

export type MissionStepDispatcher = (
  step: ClaimedMissionStep,
) => Promise<MissionDispatchResult>;

export interface MissionExecutorDiagnostic {
  runtime_role: string;
  ready_steps: number;
  ready_missions: number;
  claimable_ready_steps: number;
}

interface ExecutorDispatchContext {
  user_id: string;
  session_id: string;
  turn_id: string;
  idempotency_key: string;
  region: string;
  device_kind: "web" | "ios" | "android" | "watch";
  prior_summary: null;
  user_confirmed: boolean;
  user_pii: Record<string, unknown>;
}

let diagnosticLogged = false;

export async function runMissionExecutorTick(options: {
  db?: SupabaseLike | null;
  limit?: number;
  dispatchStep?: MissionStepDispatcher;
} = {}): Promise<MissionExecutorResult> {
  const db = (options.db ?? getSupabase()) as SupabaseLike | null;
  const counts: MissionExecutorCounts = {
    disabled: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    mission_completed: 0,
    mission_failed: 0,
  };
  const errors: string[] = [];
  if (!db) return { ok: false, counts, errors: ["supabase_not_configured"] };

  const dispatchStep = options.dispatchStep ?? dispatchMissionStep;
  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 10)));
  const attemptedStepIds = new Set<string>();

  if (process.env.LUMO_MISSION_EXECUTOR_DIAGNOSTIC === "true" && !diagnosticLogged) {
    diagnosticLogged = true;
    const diagnostic = await readMissionExecutorDiagnostic(db).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
    }));
    console.warn("[mission-executor] claim diagnostic", diagnostic);
  }

  while (counts.claimed < limit) {
    const steps = await claimReadySteps(db, 1, attemptedStepIds);
    if (steps.length === 0) break;
    const step = steps[0];
    if (!step) break;
    attemptedStepIds.add(step.id);
    counts.claimed += 1;
    try {
      await recordExecutionEvent(
        {
          mission_id: step.mission_id,
          step_id: step.id,
          event_type: "step_started",
          payload: stepStartedPayload(step),
        },
        { db },
      );

      const result = await dispatchStep(step);
      if (result.ok) {
        await markStepSucceeded(db, step, result.result);
        await recordExecutionEvent(
          {
            mission_id: step.mission_id,
            step_id: step.id,
            event_type: "step_succeeded",
            payload: stepSucceededPayload(result.latency_ms, result.result),
          },
          { db },
        );
        counts.succeeded += 1;
      } else {
        await markStepFailed(db, step, result.error.message);
        await recordExecutionEvent(
          {
            mission_id: step.mission_id,
            step_id: step.id,
            event_type: "step_failed",
            payload: stepFailedPayload(result),
          },
          { db },
        );
        counts.failed += 1;
        if (isRetryableDispatchFailure(result)) {
          // D4 records the retryability signal for D5/D6 to act on. It does
          // not requeue the step yet because there is no retry-at column.
          errors.push(`retryable_step_failed:${step.id}:${result.error.code}`);
        } else {
          errors.push(`step_failed:${step.id}:${result.error.code}`);
        }
      }

      const rollup = await rollupMissionAfterStep(db, step.mission_id, result.ok, {
        failed_step_id: result.ok ? null : step.id,
        error_text: result.ok ? null : result.error.message,
      });
      if (rollup === "mission_completed") counts.mission_completed += 1;
      if (rollup === "mission_failed") counts.mission_failed += 1;
    } catch (err) {
      counts.failed += 1;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { ok: errors.length === 0, counts, errors };
}

export async function readMissionExecutorDiagnostic(
  db: SupabaseLike,
): Promise<MissionExecutorDiagnostic> {
  if (typeof db.rpc !== "function") {
    throw new Error("mission_executor_diagnostic_rpc_missing");
  }
  const { data, error } = await db.rpc("mission_executor_claim_diagnostics");
  if (error) {
    throw new Error(`mission_executor_diagnostic_failed:${error.message ?? "unknown"}`);
  }
  const row = Array.isArray(data) ? data[0] : null;
  return {
    runtime_role: typeof row?.runtime_role === "string" ? row.runtime_role : "",
    ready_steps: numberOrZero(row?.ready_steps),
    ready_missions: numberOrZero(row?.ready_missions),
    claimable_ready_steps: numberOrZero(row?.claimable_ready_steps),
  };
}

export async function dispatchMissionStep(
  step: ClaimedMissionStep,
): Promise<MissionDispatchResult> {
  const started = Date.now();
  if (step.tool_name.startsWith("mission.")) {
    return {
      ok: true,
      latency_ms: Date.now() - started,
      result: {
        status: "acknowledged",
        agent_id: step.agent_id,
        tool_name: step.tool_name,
        inputs_hash: hashPayload(step.inputs),
      },
    };
  }

  const { dispatchToolCall } = await import("./router.ts");
  return dispatchToolCall(step.tool_name, step.inputs, dispatchContextForStep(step));
}

async function claimReadySteps(
  db: SupabaseLike,
  limit: number,
  excludedStepIds = new Set<string>(),
): Promise<ClaimedMissionStep[]> {
  const requestedLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
  if (typeof db.rpc !== "function") {
    throw new Error("mission_step_claim_rpc_missing");
  }

  const { data, error } = await db.rpc("next_mission_step_for_execution", {
    requested_limit: requestedLimit,
  });
  if (error) throw new Error(`mission_step_claim_failed:${error.message ?? "unknown"}`);
  const claimed = Array.isArray(data)
    ? data.map(normalizeClaimedStep).filter(isClaimedStep)
    : [];
  return claimed.filter((step) => !excludedStepIds.has(step.id));
}

async function markStepSucceeded(
  db: SupabaseLike,
  step: ClaimedMissionStep,
  result: unknown,
): Promise<void> {
  const { error } = await db
    .from("mission_steps")
    .update({
      status: "succeeded",
      outputs: result && typeof result === "object" ? result : { value: result },
      error_text: null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", step.id);
  if (error) throw new Error(`mission_step_succeed_failed:${error.message ?? "unknown"}`);
}

async function markStepFailed(
  db: SupabaseLike,
  step: ClaimedMissionStep,
  errorText: string,
): Promise<void> {
  const { error } = await db
    .from("mission_steps")
    .update({
      status: "failed",
      error_text: errorText,
      finished_at: new Date().toISOString(),
    })
    .eq("id", step.id);
  if (error) throw new Error(`mission_step_fail_failed:${error.message ?? "unknown"}`);
}

async function rollupMissionAfterStep(
  db: SupabaseLike,
  mission_id: string,
  lastStepSucceeded: boolean,
  failure: { failed_step_id: string | null; error_text: string | null },
): Promise<"mission_completed" | "mission_failed" | null> {
  const statuses = await readMissionStepStatuses(db, mission_id);
  const completion = missionCompletionFromStatuses(statuses, lastStepSucceeded);
  if (!completion.mission_state || !completion.terminal_event) return null;

  const currentState = await readMissionState(db, mission_id);
  if (currentState === completion.mission_state) return null;
  await updateMissionState(db, mission_id, completion.mission_state);
  const eventPayload =
    completion.terminal_event === "mission_completed"
      ? {
          step_count: statuses.length,
          succeeded_count: statuses.filter((status) => status === "succeeded").length,
        }
      : {
          failed_step_id: failure.failed_step_id,
          error_text: failure.error_text ?? "Mission step failed.",
        };
  await recordExecutionEvent(
    {
      mission_id,
      event_type: completion.terminal_event,
      payload: eventPayload,
    },
    { db },
  );
  return completion.terminal_event;
}

async function readMissionStepStatuses(
  db: SupabaseLike,
  mission_id: string,
): Promise<MissionStepStatus[]> {
  const { data, error } = await db.from("mission_steps").select("status").eq("mission_id", mission_id);
  if (error) throw new Error(`mission_steps_read_failed:${error.message ?? "unknown"}`);
  return Array.isArray(data)
    ? data.map((row) => String(row?.status ?? "")).filter(isMissionStepStatus)
    : [];
}

async function readMissionState(
  db: SupabaseLike,
  mission_id: string,
): Promise<MissionState | null> {
  const { data, error } = await db.from("missions").select("state").eq("id", mission_id).limit(1);
  if (error) throw new Error(`mission_read_failed:${error.message ?? "unknown"}`);
  const state = Array.isArray(data) ? String(data[0]?.state ?? "") : "";
  return isMissionState(state) ? state : null;
}

async function updateMissionState(
  db: SupabaseLike,
  mission_id: string,
  state: MissionState,
): Promise<void> {
  const { error } = await db.from("missions").update({ state }).eq("id", mission_id);
  if (error) throw new Error(`mission_update_failed:${error.message ?? "unknown"}`);
}

function dispatchContextForStep(step: ClaimedMissionStep): ExecutorDispatchContext {
  return {
    user_id: step.user_id,
    session_id: `mission:${step.mission_id}`,
    turn_id: `mission-step:${step.id}`,
    idempotency_key: `mission:${step.mission_id}:${step.id}`,
    region: "US",
    device_kind: "web",
    prior_summary: null,
    user_confirmed: true,
    user_pii: {},
  };
}

function normalizeClaimedStep(row: unknown): ClaimedMissionStep | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = stringOrNull(r.id);
  const mission_id = stringOrNull(r.mission_id);
  const user_id = stringOrNull(r.user_id);
  const agent_id = stringOrNull(r.agent_id);
  const tool_name = stringOrNull(r.tool_name);
  if (!id || !mission_id || !user_id || !agent_id || !tool_name) return null;
  return {
    id,
    mission_id,
    user_id,
    step_order: numberOrZero(r.step_order),
    agent_id,
    tool_name,
    reversibility: stringOrNull(r.reversibility) ?? "reversible",
    inputs: isRecord(r.inputs) ? r.inputs : {},
    confirmation_card_id: stringOrNull(r.confirmation_card_id),
  };
}

function isClaimedStep(step: ClaimedMissionStep | null): step is ClaimedMissionStep {
  return step !== null;
}

function isMissionStepStatus(status: string): status is MissionStepStatus {
  return [
    "pending",
    "awaiting_confirmation",
    "ready",
    "running",
    "succeeded",
    "failed",
    "rollback_failed",
    "rolled_back",
    "skipped",
  ].includes(status);
}

function isMissionState(state: string): state is MissionState {
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
  ].includes(state);
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
