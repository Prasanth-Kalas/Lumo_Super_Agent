import { getSupabase } from "../db.ts";
import { recordInvocationCost } from "../cost.ts";
import {
  recordExecutionEvent,
  type CompoundMissionPersistResult,
} from "../mission-execution.ts";
import type { ClaimedMissionStep } from "../mission-executor-core.ts";
import {
  dispatchArgsForMissionStep,
  dispatchMissionStepToTool,
  missionStepToDispatchTool,
  summarizeMissionStepOutput,
} from "./mission-dispatch.ts";
import type {
  CompoundMissionLeg,
  CompoundMissionPlan,
} from "./mission-planner.ts";
import {
  flightOffersSelectionPayload,
  isFlightOfferDiscoveryTool,
} from "../flight-offers-selection.ts";

type InteractiveSelection = {
  kind: "food_menu" | "flight_offers" | "time_slots";
  payload: unknown;
};

export interface AssistantCompoundStepUpdateFrameValue {
  kind: "assistant_compound_step_update";
  compound_transaction_id: string;
  leg_id: string;
  status: "pending" | "in_flight" | "committed" | "failed";
  output_summary?: string;
  provider_reference?: string | null;
  evidence?: Record<string, unknown> | null;
  timestamp: string;
}

export interface CompoundMissionRunToolCall {
  name: string;
  agent_id: string;
  latency_ms: number;
  ok: boolean;
  error_code?: string;
}

export interface CompoundMissionRunResult {
  tool_calls: CompoundMissionRunToolCall[];
  selections: InteractiveSelection[];
  outputs: Array<{
    leg: CompoundMissionLeg;
    ok: boolean;
    output_summary: string;
    result: unknown;
    error_code?: string;
  }>;
  final_text: string;
}

interface SupabaseLike {
  from(table: string): any;
}

export async function runCompoundMissionInline(input: {
  plan: CompoundMissionPlan;
  persisted: CompoundMissionPersistResult;
  user_id: string;
  session_id: string;
  user_region: string;
  device_kind: "web" | "ios" | "android" | "watch";
  user_pii: Record<string, unknown>;
  emitStepUpdate: (frame: AssistantCompoundStepUpdateFrameValue) => void;
  emitTool?: (frame: CompoundMissionRunToolCall) => void;
  emitSelection?: (selection: InteractiveSelection) => void;
  db?: SupabaseLike | null;
}): Promise<CompoundMissionRunResult> {
  const db = input.db ?? getSupabase();
  const dispatchId = input.persisted.dispatch_id ?? `mission:${input.plan.graph_hash}`;
  const stepsByClientId = new Map(
    input.persisted.steps.map((step) => [step.client_step_id, step]),
  );
  const toolCalls: CompoundMissionRunToolCall[] = [];
  const selections: InteractiveSelection[] = [];
  const outputs: CompoundMissionRunResult["outputs"] = [];
  const levels = topologicalLevels(input.plan);

  for (const level of levels) {
    const levelOutputs = await Promise.all(
      level.map(async (leg) => {
        const persistedStep = stepsByClientId.get(leg.client_step_id);
        const step: ClaimedMissionStep = {
          id: persistedStep?.id ?? `${input.plan.graph_hash}:${leg.client_step_id}`,
          mission_id: input.persisted.mission_id ?? input.plan.graph_hash,
          user_id: input.user_id,
          step_order: persistedStep?.step_order ?? input.plan.legs.indexOf(leg) + 1,
          agent_id: leg.agent_id,
          tool_name: leg.mission_tool_name,
          reversibility: "reversible",
          inputs: {
            client_step_id: leg.client_step_id,
            description: leg.description,
            dispatch_tool_name: leg.dispatch_tool_name,
            line_items_hint: leg.line_items_hint,
            graph_hash: input.plan.graph_hash,
          },
          confirmation_card_id: null,
        };
        const dispatchToolName = missionStepToDispatchTool(step) ?? leg.dispatch_tool_name;
        input.emitStepUpdate(stepUpdate(dispatchId, leg.client_step_id, "in_flight"));
        await markStepRunning(db, step);
        await recordMissionEvent(db, {
          mission_id: step.mission_id,
          step_id: persistedStep?.id ?? null,
          event_type: "mission_step_progress",
          payload: {
            client_step_id: leg.client_step_id,
            status: "in_flight",
            dispatch_tool_name: dispatchToolName,
          },
        });

        const outcome = await dispatchMissionStepToTool(step, {
          user_id: input.user_id,
          session_id: input.session_id,
          turn_id: `${input.session_id}:compound:${leg.client_step_id}`,
          idempotency_key: `${input.session_id}:compound:${input.plan.graph_hash}:${leg.client_step_id}`,
          region: input.user_region,
          device_kind: input.device_kind,
          prior_summary: null,
          user_confirmed: true,
          user_pii: input.user_pii,
        });
        const outputSummary = outcome.ok
          ? summarizeMissionStepOutput(step, outcome.result)
          : outcome.error.message;
        const toolCall: CompoundMissionRunToolCall = {
          name: dispatchToolName,
          agent_id: leg.agent_id,
          latency_ms: outcome.latency_ms,
          ok: outcome.ok,
          error_code: outcome.ok ? undefined : outcome.error.code,
        };
        toolCalls.push(toolCall);
        input.emitTool?.(toolCall);

        if (outcome.ok) {
          await markStepSucceeded(db, step, outcome.result, outputSummary);
          await recordMissionEvent(db, {
            mission_id: step.mission_id,
            step_id: persistedStep?.id ?? null,
            event_type: "mission_step_progress",
            payload: {
              client_step_id: leg.client_step_id,
              status: "committed",
              dispatch_tool_name: dispatchToolName,
              output_summary: outputSummary,
            },
          });
          input.emitStepUpdate(
            stepUpdate(dispatchId, leg.client_step_id, "committed", outputSummary, {
              dispatch_tool_name: dispatchToolName,
              output_hash_source: "mission_step_output",
            }),
          );
          if (isFlightOfferDiscoveryTool(dispatchToolName)) {
            const selection: InteractiveSelection = {
              kind: "flight_offers",
              payload: flightOffersSelectionPayload(dispatchToolName, outcome.result),
            };
            selections.push(selection);
            input.emitSelection?.(selection);
          }
        } else {
          await markStepFailed(db, step, outcome.error.message, outputSummary);
          await recordMissionEvent(db, {
            mission_id: step.mission_id,
            step_id: persistedStep?.id ?? null,
            event_type: "mission_step_progress",
            payload: {
              client_step_id: leg.client_step_id,
              status: "failed",
              dispatch_tool_name: dispatchToolName,
              error_code: outcome.error.code,
              output_summary: outputSummary,
            },
          });
          input.emitStepUpdate(
            stepUpdate(dispatchId, leg.client_step_id, "failed", outputSummary, {
              dispatch_tool_name: dispatchToolName,
              error_code: outcome.error.code,
            }),
          );
        }

        void recordInvocationCost({
          requestId: `${input.session_id}:compound-mission:${input.plan.graph_hash}:${leg.client_step_id}`,
          userId: input.user_id,
          agentId: leg.agent_id,
          agentVersion: "compound-mission",
          missionId: input.persisted.mission_id,
          missionStepId: persistedStep?.id,
          capabilityId: dispatchToolName,
          status: outcome.ok ? "completed" : "aborted_error",
          costUsdTotal: 0,
          evidence: {
            actual_source: "compound_mission_runner",
            graph_hash: input.plan.graph_hash,
            output_summary: outputSummary,
          },
        });

        return {
          leg,
          ok: outcome.ok,
          output_summary: outputSummary,
          result: outcome.ok ? outcome.result : outcome.error,
          error_code: outcome.ok ? undefined : outcome.error.code,
        };
      }),
    );
    outputs.push(...levelOutputs);
  }

  await finishComposeStep(db, input.persisted, input.plan, outputs);
  await updateMissionState(
    db,
    input.persisted.mission_id,
    outputs.every((output) => output.ok) ? "completed" : "failed",
  );

  return {
    tool_calls: toolCalls,
    selections,
    outputs,
    final_text: composeFinalText(outputs),
  };
}

function topologicalLevels(plan: CompoundMissionPlan): CompoundMissionLeg[][] {
  const byId = new Map(plan.legs.map((leg) => [leg.client_step_id, leg]));
  const remaining = new Set(plan.legs.map((leg) => leg.client_step_id));
  const completed = new Set<string>();
  const depsByDependent = new Map<string, Set<string>>();
  for (const edge of plan.dependencies) {
    const deps = depsByDependent.get(edge.dependent_step_id) ?? new Set<string>();
    deps.add(edge.dependency_step_id);
    depsByDependent.set(edge.dependent_step_id, deps);
  }
  const levels: CompoundMissionLeg[][] = [];
  while (remaining.size > 0) {
    const ready = Array.from(remaining)
      .filter((id) => Array.from(depsByDependent.get(id) ?? []).every((dep) => completed.has(dep)))
      .sort();
    if (ready.length === 0) throw new Error("cyclic_compound_mission_graph");
    levels.push(ready.map((id) => byId.get(id)).filter((leg): leg is CompoundMissionLeg => Boolean(leg)));
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return levels;
}

function stepUpdate(
  dispatchId: string,
  legId: string,
  status: AssistantCompoundStepUpdateFrameValue["status"],
  outputSummary?: string,
  evidence?: Record<string, unknown>,
): AssistantCompoundStepUpdateFrameValue {
  return {
    kind: "assistant_compound_step_update",
    compound_transaction_id: dispatchId,
    leg_id: legId,
    status,
    output_summary: outputSummary,
    evidence: evidence ?? null,
    provider_reference: null,
    timestamp: new Date().toISOString(),
  };
}

async function markStepRunning(db: SupabaseLike | null, step: ClaimedMissionStep): Promise<void> {
  if (!db || !isUuid(step.id)) return;
  await db
    .from("mission_steps")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      error_text: null,
    })
    .eq("id", step.id);
}

async function markStepSucceeded(
  db: SupabaseLike | null,
  step: ClaimedMissionStep,
  result: unknown,
  outputSummary: string,
): Promise<void> {
  if (!db || !isUuid(step.id)) return;
  await db
    .from("mission_steps")
    .update({
      status: "succeeded",
      outputs: result && typeof result === "object" ? result : { value: result },
      output_summary: outputSummary,
      error_text: null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", step.id);
}

async function markStepFailed(
  db: SupabaseLike | null,
  step: ClaimedMissionStep,
  errorText: string,
  outputSummary: string,
): Promise<void> {
  if (!db || !isUuid(step.id)) return;
  await db
    .from("mission_steps")
    .update({
      status: "failed",
      error_text: errorText,
      output_summary: outputSummary,
      finished_at: new Date().toISOString(),
    })
    .eq("id", step.id);
}

async function finishComposeStep(
  db: SupabaseLike | null,
  persisted: CompoundMissionPersistResult,
  plan: CompoundMissionPlan,
  outputs: CompoundMissionRunResult["outputs"],
): Promise<void> {
  const compose = persisted.steps.find((step) => step.client_step_id === plan.compose_step.client_step_id);
  if (!db || !compose || !isUuid(compose.id)) return;
  const output = { summaries: outputs.map((item) => ({
    client_step_id: item.leg.client_step_id,
    ok: item.ok,
    output_summary: item.output_summary,
    error_code: item.error_code ?? null,
  })) };
  await db
    .from("mission_steps")
    .update({
      status: "succeeded",
      outputs: output,
      output_summary: "Final reply composed from mission outputs.",
      error_text: null,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    })
    .eq("id", compose.id);
}

async function updateMissionState(
  db: SupabaseLike | null,
  missionId: string | null,
  state: "completed" | "failed",
): Promise<void> {
  if (!db || !missionId || !isUuid(missionId)) return;
  await db.from("missions").update({ state }).eq("id", missionId);
}

async function recordMissionEvent(
  db: SupabaseLike | null,
  input: Parameters<typeof recordExecutionEvent>[0],
): Promise<void> {
  if (!db || !isUuid(input.mission_id)) return;
  await recordExecutionEvent(input, { db });
}

function composeFinalText(outputs: CompoundMissionRunResult["outputs"]): string {
  const successes = outputs.filter((output) => output.ok);
  const failures = outputs.filter((output) => !output.ok);
  const parts = successes.map((output) => output.output_summary);
  if (failures.length > 0) {
    parts.push(
      failures
        .map((output) => `${labelForLeg(output.leg)} could not finish: ${output.output_summary}`)
        .join(" "),
    );
  }
  if (parts.length === 0) return "I could not complete any part of that trip plan yet.";
  return `${parts.join(" ")} Pick from the cards below where available, and I can keep going.`;
}

function labelForLeg(leg: CompoundMissionLeg): string {
  if (leg.client_step_id === "flight_search") return "Flight search";
  if (leg.client_step_id === "hotel_search") return "Hotel search";
  if (leg.client_step_id === "restaurant_search") return "Dinner search";
  if (leg.client_step_id === "food_search") return "Food search";
  return leg.description;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
