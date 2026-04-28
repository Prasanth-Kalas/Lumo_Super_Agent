import type {
  MissionState,
  MissionStepStatus,
  Reversibility,
} from "./mission-execution-core.ts";

export type RollbackTrigger = "user" | "admin" | "auto";

export type RollbackEventType =
  | "rollback_initiated"
  | "rollback_step_started"
  | "rollback_step_succeeded"
  | "rollback_step_failed"
  | "rollback_step_skipped"
  | "rollback_completed";

export type RollbackSkipReason =
  | "reversible_noop"
  | "irreversible"
  | "no_compensating_tool"
  | "already_terminal"
  | "compensation_window_expired";

export interface RollbackMissionRow {
  id: string;
  user_id?: string | null;
  state: MissionState;
  updated_at?: string | null;
}

export interface RollbackStepRow {
  id: string;
  mission_id: string;
  user_id?: string;
  step_order: number;
  agent_id: string;
  tool_name: string;
  reversibility: Reversibility | string;
  status: MissionStepStatus | string;
  inputs?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
  finished_at?: string | null;
  confirmation_card_id?: string | null;
}

export interface RollbackEventRow {
  mission_id?: string | null;
  step_id?: string | null;
  event_type: string;
  payload?: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface CompensatingAction {
  kind: "compensate";
  tool_name: string;
  inputs: Record<string, unknown>;
}

export interface SkipRollbackAction {
  kind: "skip";
  reason: RollbackSkipReason;
}

export type RollbackStepAction = CompensatingAction | SkipRollbackAction;

const ACTIVE_ROLLBACK_STATES = new Set<MissionState>([
  "awaiting_permissions",
  "awaiting_user_input",
  "ready",
  "executing",
  "awaiting_confirmation",
  "failed",
]);

const TERMINAL_ROLLBACK_EVENTS = new Set([
  "rollback_step_succeeded",
  "rollback_step_failed",
  "rollback_step_skipped",
]);

const NEVER_EXECUTED_STEP_STATUSES = new Set([
  "pending",
  "awaiting_confirmation",
  "ready",
  "skipped",
  "rolled_back",
]);

export function rollbackTransition(
  current: MissionState,
  options: { trigger: RollbackTrigger; force?: boolean } = { trigger: "auto" },
): { ok: boolean; target?: MissionState; reason?: string } {
  if (current === "rolled_back") {
    return { ok: false, reason: "mission_already_rolled_back" };
  }
  if (current === "rolling_back") {
    return { ok: true, target: "rolling_back" };
  }
  if (options.force === true || current === "completed") {
    return { ok: true, target: "rolling_back" };
  }
  if (current === "awaiting_permissions") {
    return { ok: true, target: "rolled_back" };
  }
  if (ACTIVE_ROLLBACK_STATES.has(current)) {
    return { ok: true, target: "rolling_back" };
  }
  return { ok: false, reason: `rollback_not_allowed:${current}` };
}

export function renderCompensatingInputs(
  template: unknown,
  outputs: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!isRecord(template)) return {};
  const rendered = renderTemplateValue(template, { outputs });
  return isRecord(rendered) ? rendered : {};
}

export function rollbackStepAlreadyTerminal(
  stepId: string,
  events: RollbackEventRow[],
): boolean {
  return events.some(
    (event) => event.step_id === stepId && TERMINAL_ROLLBACK_EVENTS.has(event.event_type),
  );
}

export function rollbackStepAlreadyStarted(
  stepId: string,
  events: RollbackEventRow[],
): boolean {
  return events.some(
    (event) =>
      event.step_id === stepId &&
      (event.event_type === "rollback_step_started" ||
        TERMINAL_ROLLBACK_EVENTS.has(event.event_type)),
  );
}

export function rollbackActionForStep(
  step: RollbackStepRow,
  events: RollbackEventRow[] = [],
  now: Date = new Date(),
): RollbackStepAction {
  if (rollbackStepAlreadyTerminal(step.id, events)) {
    return { kind: "skip", reason: "already_terminal" };
  }

  const reversibility = normalizeReversibility(step.reversibility);
  if (reversibility === "reversible") return { kind: "skip", reason: "reversible_noop" };
  if (reversibility === "irreversible") return { kind: "skip", reason: "irreversible" };

  const metadata = rollbackMetadataFromInputs(step.inputs);
  if (!metadata.compensating_tool) return { kind: "skip", reason: "no_compensating_tool" };
  if (
    typeof metadata.compensating_window_seconds === "number" &&
    step.finished_at &&
    now.getTime() - Date.parse(step.finished_at) >
      metadata.compensating_window_seconds * 1000
  ) {
    return { kind: "skip", reason: "compensation_window_expired" };
  }

  return {
    kind: "compensate",
    tool_name: metadata.compensating_tool,
    inputs: renderCompensatingInputs(
      metadata.compensating_inputs_template,
      step.outputs ?? {},
    ),
  };
}

export function rollbackCompleteFromSteps(
  steps: RollbackStepRow[],
  events: RollbackEventRow[],
): { complete: boolean; failed: boolean; counts: Record<string, number> } {
  const forwardSucceeded = steps.filter((step) =>
    ["succeeded", "rollback_failed"].includes(String(step.status)),
  );
  const counts = {
    forward_steps: forwardSucceeded.length,
    succeeded: 0,
    skipped: 0,
    failed: 0,
  };
  if (
    forwardSucceeded.length === 0 &&
    steps.some((step) => !NEVER_EXECUTED_STEP_STATUSES.has(String(step.status)))
  ) {
    return { complete: false, failed: false, counts };
  }
  for (const step of forwardSucceeded) {
    const terminal = events.find(
      (event) =>
        event.step_id === step.id && TERMINAL_ROLLBACK_EVENTS.has(event.event_type),
    );
    if (!terminal) return { complete: false, failed: false, counts };
    if (terminal.event_type === "rollback_step_succeeded") counts.succeeded += 1;
    if (terminal.event_type === "rollback_step_skipped") counts.skipped += 1;
    if (terminal.event_type === "rollback_step_failed") counts.failed += 1;
  }
  return { complete: true, failed: counts.failed > 0, counts };
}

export function rollbackStartedPayload(input: {
  trigger: RollbackTrigger;
  actor_user_id?: string | null;
  reason?: string | null;
}): Record<string, unknown> {
  return {
    trigger: input.trigger,
    actor_user_id: input.actor_user_id ?? null,
    reason: input.reason ?? null,
  };
}

export function rollbackStepPayload(
  step: RollbackStepRow,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    step_order: step.step_order,
    agent_id: step.agent_id,
    tool_name: step.tool_name,
    reversibility: normalizeReversibility(step.reversibility),
    ...extra,
  };
}

function rollbackMetadataFromInputs(input: unknown): {
  compensating_tool?: string;
  compensating_inputs_template?: Record<string, unknown>;
  compensating_window_seconds?: number;
} {
  const inputs = isRecord(input) ? input : {};
  const nested = isRecord(inputs.rollback) ? inputs.rollback : {};
  const compensating_tool =
    stringOrNull(nested.compensating_tool) ??
    stringOrNull(inputs.compensating_tool) ??
    stringOrNull(inputs.cancels);
  const template =
    recordOrNull(nested.compensating_inputs_template) ??
    recordOrNull(inputs.compensating_inputs_template);
  const windowSeconds =
    numberOrNull(nested.compensating_window_seconds) ??
    numberOrNull(inputs.compensating_window_seconds);
  return {
    compensating_tool: compensating_tool ?? undefined,
    compensating_inputs_template: template ?? undefined,
    compensating_window_seconds: windowSeconds ?? undefined,
  };
}

function renderTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
      const resolved = valueAtPath(context, path);
      if (resolved === undefined || resolved === null) return "";
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, context));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, renderTemplateValue(child, context)]),
  );
}

function valueAtPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function normalizeReversibility(input: unknown): Reversibility {
  return input === "compensating" || input === "irreversible" ? input : "reversible";
}

function recordOrNull(input: unknown): Record<string, unknown> | null {
  return isRecord(input) ? input : null;
}

function numberOrNull(input: unknown): number | null {
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

function stringOrNull(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
