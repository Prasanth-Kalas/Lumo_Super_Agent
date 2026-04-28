import type { MissionState, MissionStepStatus } from "./mission-execution-core.ts";

export interface GateMission {
  id: string;
  user_id?: string | null;
  session_id?: string | null;
  state: MissionState | string;
  plan?: Record<string, unknown> | null;
}

export interface GateMissionStep {
  id: string;
  mission_id: string;
  agent_id: string;
  status: MissionStepStatus | string;
  inputs?: Record<string, unknown> | null;
}

export interface PermissionGateResolution {
  step_ids: string[];
  blocked_agent_ids: string[];
  complete: boolean;
  next_state: MissionState;
  reason?: string;
}

export interface InputGateResolution {
  complete: boolean;
  next_state: MissionState;
  merged_inputs: Record<string, unknown>;
  merged_plan: Record<string, unknown>;
  reason?: string;
}

export function stepsToAdvanceOnPermissionGrant(
  mission: GateMission,
  steps: GateMissionStep[] | null | undefined,
  agent_id: string,
): PermissionGateResolution {
  const normalizedAgentId = agent_id.trim();
  if (!normalizedAgentId) {
    return {
      step_ids: [],
      blocked_agent_ids: [],
      complete: false,
      next_state: asMissionState(mission.state) ?? "awaiting_permissions",
      reason: "missing_agent_id",
    };
  }
  if (mission.state !== "awaiting_permissions") {
    return {
      step_ids: [],
      blocked_agent_ids: [],
      complete: false,
      next_state: asMissionState(mission.state) ?? "awaiting_permissions",
      reason: `mission_not_awaiting_permissions:${mission.state}`,
    };
  }

  const stepList = Array.isArray(steps) ? steps : [];
  const stepIds = stepList
    .filter((step) => step.status === "pending" && step.agent_id === normalizedAgentId)
    .map((step) => step.id)
    .filter(Boolean);

  if (stepIds.length === 0) {
    return {
      step_ids: [],
      blocked_agent_ids: blockedAgentIds(stepList),
      complete: false,
      next_state: "awaiting_permissions",
      reason: "no_matching_pending_steps",
    };
  }

  const advanced = new Set(stepIds);
  const blocked = blockedAgentIds(
    stepList.filter((step) => step.status === "pending" && !advanced.has(step.id)),
  );

  return {
    step_ids: stepIds,
    blocked_agent_ids: blocked,
    complete: blocked.length === 0,
    next_state: blocked.length > 0 ? "awaiting_permissions" : "ready",
    reason: blocked.length > 0 ? "permission_blocked" : undefined,
  };
}

export function inputAdvancement(
  mission: GateMission,
  newInputs: Record<string, unknown> | null | undefined,
): InputGateResolution {
  const state = asMissionState(mission.state) ?? "awaiting_user_input";
  const plan = isRecord(mission.plan) ? mission.plan : {};
  const priorInputs = isRecord(plan.input_answers) ? plan.input_answers : {};
  const incoming = sanitizeInputRecord(newInputs);
  const mergedInputs = { ...priorInputs, ...incoming };
  const requiredKeys = readRequiredInputKeys(plan);
  const hasIncoming = hasMeaningfulValue(incoming);

  if (state !== "awaiting_user_input") {
    return {
      complete: false,
      next_state: state,
      merged_inputs: mergedInputs,
      merged_plan: { ...plan, input_answers: mergedInputs },
      reason: `mission_not_awaiting_user_input:${state}`,
    };
  }

  const complete =
    requiredKeys.length > 0
      ? requiredKeys.every((key) => hasMeaningfulValue(mergedInputs[key]))
      : hasInputQuestion(plan)
        ? hasMeaningfulValue(mergedInputs)
        : true;

  return {
    complete,
    next_state: complete ? "ready" : "awaiting_user_input",
    merged_inputs: mergedInputs,
    merged_plan: {
      ...plan,
      input_answers: mergedInputs,
      input_gate_updated_at: new Date().toISOString(),
      ...(complete ? { input_gate_resolved_at: new Date().toISOString() } : {}),
    },
    reason: complete ? undefined : hasIncoming ? "required_inputs_missing" : "no_inputs_provided",
  };
}

export function isAwaitingInputComplete(mission: GateMission): boolean {
  return inputAdvancement(mission, {}).complete;
}

export function pendingStepIds(steps: GateMissionStep[] | null | undefined): string[] {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => step.status === "pending")
    .map((step) => step.id)
    .filter(Boolean);
}

function blockedAgentIds(steps: GateMissionStep[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step.status !== "pending") continue;
    const agentId = step.agent_id.trim();
    if (agentId) out.add(agentId);
  }
  return Array.from(out).sort();
}

function readRequiredInputKeys(plan: Record<string, unknown>): string[] {
  const candidates = [plan.required_inputs, plan.input_requirements];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const keys = candidate
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (isRecord(item) && typeof item.key === "string") return item.key.trim();
        if (isRecord(item) && typeof item.name === "string") return item.name.trim();
        return "";
      })
      .filter(Boolean);
    if (keys.length > 0) return Array.from(new Set(keys));
  }
  return [];
}

function hasInputQuestion(plan: Record<string, unknown>): boolean {
  return Array.isArray(plan.user_questions) && plan.user_questions.length > 0;
}

function sanitizeInputRecord(input: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out[trimmedKey] = trimmed.slice(0, 2000);
      continue;
    }
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      Array.isArray(value) ||
      isRecord(value)
    ) {
      out[trimmedKey] = value;
    }
  }
  return out;
}

function hasMeaningfulValue(input: unknown): boolean {
  if (typeof input === "string") return input.trim().length > 0;
  if (typeof input === "number") return Number.isFinite(input);
  if (typeof input === "boolean") return true;
  if (Array.isArray(input)) return input.some(hasMeaningfulValue);
  if (isRecord(input)) return Object.values(input).some(hasMeaningfulValue);
  return false;
}

function asMissionState(input: unknown): MissionState | null {
  return typeof input === "string" && isMissionState(input) ? input : null;
}

function isMissionState(input: string): input is MissionState {
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
  ].includes(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
