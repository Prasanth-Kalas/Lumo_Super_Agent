import type { PlanRequest, PlanResponse } from "@lumo/shared-types";
import { getSupabase } from "../db.ts";
import type { AssistantSuggestionsFrameValue } from "../chat-suggestions.ts";
import type { ChatMessage, OrchestratorInput } from "../orchestrator.ts";
import type { PlanningStep } from "../chat-suggestions.ts";
import type { AgentTimingBucket } from "../perf/timing-spans.ts";
import type { SessionAppApproval } from "../session-app-approvals.ts";
import { callPlan, type PlanResponseResult } from "./plan-client.ts";

export interface AgentPlanCompareRow {
  session_id: string;
  turn_id: string;
  user_id: string | null;
  ts_intent_bucket: AgentTimingBucket | null;
  py_intent_bucket: PlanResponse["intent_bucket"] | null;
  ts_planning_step: PlanningStep | null;
  py_planning_step: PlanResponse["planning_step"] | null;
  agreement_bucket: boolean | null;
  agreement_step: boolean | null;
  ts_latency_ms: number | null;
  py_latency_ms: number | null;
  py_was_stub: boolean | null;
  py_error: string | null;
  suggestions_python: string[];
  suggestions_ts: string[];
  suggestions_jaccard: number | null;
}

export interface PlanCompareRecorder {
  readonly request: PlanRequest;
  captureTsIntent(bucket: AgentTimingBucket, latencyMs: number): void;
  flush(args: {
    turnId: string;
    planningStep?: PlanningStep | null;
    assistantText?: string | null;
    suggestions?: AssistantSuggestionsFrameValue | null;
  }): void;
}

interface CreatePlanCompareRecorderInput {
  input: OrchestratorInput;
  approvals: SessionAppApproval[];
}

interface WritePlanCompareInput {
  request: PlanRequest;
  sessionId: string;
  turnId: string;
  userId: string | null;
  tsIntentBucket: AgentTimingBucket | null;
  tsPlanningStep: PlanningStep | null;
  tsLatencyMs: number | null;
  tsSuggestions: AssistantSuggestionsFrameValue | null;
}

export function createPlanCompareRecorder({
  input,
  approvals,
}: CreatePlanCompareRecorderInput): PlanCompareRecorder {
  const request = buildPlanRequest({ input, approvals });
  let flushed = false;
  let tsIntentBucket: AgentTimingBucket | null = null;
  let tsLatencyMs: number | null = null;

  return {
    request,
    captureTsIntent(bucket, latencyMs) {
      tsIntentBucket = bucket;
      tsLatencyMs = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null;
    },
    flush({ turnId, planningStep, assistantText, suggestions }) {
      if (flushed) return;
      flushed = true;
      const requestWithTurnContext = buildPlanRequest({
        input,
        approvals,
        planningStepHint: planningStep ?? null,
        lastAssistantMessage: assistantText ?? null,
      });
      void writePlanCompareRow({
        request: requestWithTurnContext,
        sessionId: input.session_id,
        turnId,
        userId: input.user_id && input.user_id !== "anon" ? input.user_id : null,
        tsIntentBucket,
        tsPlanningStep: planningStep ?? null,
        tsLatencyMs,
        tsSuggestions: suggestions ?? null,
      }).catch((error) => {
        console.warn("[plan-compare] write failed", error);
      });
    },
  };
}

export function buildPlanRequest({
  input,
  approvals,
  planningStepHint = null,
  lastAssistantMessage = null,
}: CreatePlanCompareRecorderInput & {
  planningStepHint?: PlanningStep | null;
  lastAssistantMessage?: string | null;
}): PlanRequest {
  const lastUser =
    input.messages
      .slice()
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
  return {
    user_message: truncate(lastUser, 4000),
    session_id: input.session_id,
    user_id: input.user_id || "anon",
    history: input.messages.slice(-24).map(toPlanChatTurn),
    approvals: approvals.slice(0, 64).map(toPlanApproval),
    planning_step_hint: planningStepHint,
    last_assistant_message: lastAssistantMessage
      ? truncate(lastAssistantMessage, 20_000)
      : null,
  };
}

export async function writePlanCompareRow(
  input: WritePlanCompareInput,
): Promise<AgentPlanCompareRow> {
  const pyResult = await callPlan(input.request);
  const row = buildPlanCompareInsertRow({
    ...input,
    pyResult,
  });
  const supabase = getSupabase();
  if (!supabase) return row;
  const { error } = await supabase.from("agent_plan_compare").insert(row);
  if (error) {
    console.warn("[plan-compare] insert failed", error.message);
  }
  return row;
}

export function buildPlanCompareInsertRow(input: WritePlanCompareInput & {
  pyResult: PlanResponseResult;
}): AgentPlanCompareRow {
  const pyIntentBucket = input.pyResult.ok
    ? input.pyResult.response.intent_bucket
    : null;
  const pyPlanningStep = input.pyResult.ok
    ? input.pyResult.response.planning_step
    : null;
  const suggestionsTs = suggestionLabelsFromAssistantFrame(input.tsSuggestions);
  const suggestionsPython = input.pyResult.ok
    ? suggestionLabelsFromPlanResponse(input.pyResult.response)
    : [];
  return {
    session_id: sanitizeNoWhitespace(input.sessionId, 200),
    turn_id: sanitizeNoWhitespace(input.turnId, 240),
    user_id: input.userId,
    ts_intent_bucket: input.tsIntentBucket,
    py_intent_bucket: pyIntentBucket,
    ts_planning_step: input.tsPlanningStep,
    py_planning_step: pyPlanningStep,
    agreement_bucket:
      input.tsIntentBucket && pyIntentBucket
        ? input.tsIntentBucket === pyIntentBucket
        : null,
    agreement_step:
      input.tsPlanningStep && pyPlanningStep
        ? input.tsPlanningStep === pyPlanningStep
        : null,
    ts_latency_ms: input.tsLatencyMs,
    py_latency_ms: input.pyResult.latency_ms,
    py_was_stub: input.pyResult.ok ? input.pyResult.was_stub : null,
    py_error: input.pyResult.ok ? null : truncate(input.pyResult.error, 240),
    suggestions_python: suggestionsPython,
    suggestions_ts: suggestionsTs,
    suggestions_jaccard: input.pyResult.ok
      ? suggestionJaccard(suggestionsTs, suggestionsPython)
      : null,
  };
}

export function suggestionLabelsFromAssistantFrame(
  frame: AssistantSuggestionsFrameValue | null | undefined,
): string[] {
  return normalizeSuggestionLabels(frame?.suggestions ?? []);
}

export function suggestionLabelsFromPlanResponse(
  response: PlanResponse,
): string[] {
  return normalizeSuggestionLabels(response.suggestions ?? []);
}

export function suggestionJaccard(
  tsSuggestions: string[],
  pySuggestions: string[],
): number | null {
  const ts = new Set(tsSuggestions);
  const py = new Set(pySuggestions);
  if (ts.size === 0 && py.size === 0) return null;
  let intersection = 0;
  for (const label of ts) {
    if (py.has(label)) intersection++;
  }
  const union = new Set([...ts, ...py]).size;
  return union === 0 ? null : intersection / union;
}

function normalizeSuggestionLabels(
  suggestions: Array<{ label?: unknown; value?: unknown }>,
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const raw =
      typeof suggestion.label === "string" && suggestion.label.trim()
        ? suggestion.label
        : typeof suggestion.value === "string"
          ? suggestion.value
          : "";
    const label = truncate(raw.trim(), 120);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= 4) break;
  }
  return labels;
}

function toPlanChatTurn(
  message: ChatMessage,
): NonNullable<PlanRequest["history"]>[number] {
  return {
    role: message.role,
    content: truncate(message.content, 2000),
  };
}

function toPlanApproval(
  approval: SessionAppApproval,
): NonNullable<PlanRequest["approvals"]>[number] {
  return {
    user_id: approval.user_id,
    session_id: approval.session_id,
    agent_id: approval.agent_id,
    granted_scopes: approval.granted_scopes,
    approved_at: approval.approved_at,
    connected_at: approval.connected_at,
    connection_provider: approval.connection_provider,
  };
}

function sanitizeNoWhitespace(value: string, max: number): string {
  const compact = value.replace(/\s+/g, "_").trim();
  return compact.slice(0, max) || "unknown";
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
