import { createHash } from "node:crypto";
import type { AgentError } from "@lumo/agent-sdk";
import type { MissionState, MissionStepStatus } from "./mission-execution-core.ts";

export interface ClaimedMissionStep {
  id: string;
  mission_id: string;
  user_id: string;
  step_order: number;
  agent_id: string;
  tool_name: string;
  reversibility: string;
  inputs: Record<string, unknown>;
  confirmation_card_id: string | null;
}

export interface DispatchSuccess {
  ok: true;
  result: unknown;
  latency_ms: number;
}

export interface DispatchFailure {
  ok: false;
  error: Pick<AgentError, "code" | "message" | "detail">;
  latency_ms: number;
}

export type MissionDispatchResult = DispatchSuccess | DispatchFailure;

export interface RetryPolicy {
  max_attempts: number;
  backoff_seconds: number[];
}

export interface MissionStepCompletion {
  step_status: MissionStepStatus;
  mission_state: MissionState | null;
  terminal_event: "mission_completed" | "mission_failed" | null;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_attempts: 3,
  backoff_seconds: [2, 8, 30],
};

const RETRYABLE_ERROR_CODES = new Set([
  "rate_limited",
  "upstream_error",
  "upstream_timeout",
  "price_changed",
]);

const STUCK_RUNNING_MS = 5 * 60 * 1000;

export function decodeRetryPolicy(input: unknown): RetryPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_RETRY_POLICY };
  }
  const record = input as Record<string, unknown>;
  const maxAttempts = clampInt(record.max_attempts, 1, 5, DEFAULT_RETRY_POLICY.max_attempts);
  const rawBackoff = Array.isArray(record.backoff_seconds)
    ? record.backoff_seconds
    : DEFAULT_RETRY_POLICY.backoff_seconds;
  const backoff = rawBackoff
    .map((value) => clampInt(value, 1, 300, NaN))
    .filter((value) => Number.isFinite(value))
    .slice(0, maxAttempts);
  return {
    max_attempts: maxAttempts,
    backoff_seconds: backoff.length > 0 ? backoff : [...DEFAULT_RETRY_POLICY.backoff_seconds],
  };
}

export function backoffSecondsForAttempt(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  const index = Math.max(0, Math.min(policy.backoff_seconds.length - 1, attempt - 1));
  return policy.backoff_seconds[index] ?? DEFAULT_RETRY_POLICY.backoff_seconds[index] ?? 30;
}

export function isRetryableDispatchFailure(result: DispatchFailure): boolean {
  return RETRYABLE_ERROR_CODES.has(result.error.code);
}

export function isStuckRunningStep(
  step: { status: MissionStepStatus; updated_at?: string | null },
  now: Date = new Date(),
  cutoffMs = STUCK_RUNNING_MS,
): boolean {
  if (step.status !== "running") return false;
  if (!step.updated_at) return false;
  const updatedAt = Date.parse(step.updated_at);
  if (!Number.isFinite(updatedAt)) return false;
  return now.getTime() - updatedAt > cutoffMs;
}

export function missionCompletionFromStatuses(
  statuses: MissionStepStatus[],
  lastStepSucceeded: boolean,
): MissionStepCompletion {
  if (statuses.some((status) => status === "failed")) {
    return {
      step_status: lastStepSucceeded ? "succeeded" : "failed",
      mission_state: "failed",
      terminal_event: "mission_failed",
    };
  }
  if (
    statuses.length > 0 &&
    statuses.every((status) => status === "succeeded" || status === "skipped")
  ) {
    return {
      step_status: "succeeded",
      mission_state: "completed",
      terminal_event: "mission_completed",
    };
  }
  if (statuses.some((status) => status === "awaiting_confirmation")) {
    return {
      step_status: lastStepSucceeded ? "succeeded" : "failed",
      mission_state: "awaiting_confirmation",
      terminal_event: null,
    };
  }
  return {
    step_status: lastStepSucceeded ? "succeeded" : "failed",
    mission_state: null,
    terminal_event: null,
  };
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function stepStartedPayload(step: ClaimedMissionStep): Record<string, unknown> {
  return {
    tool_name: step.tool_name,
    agent_id: step.agent_id,
    inputs_hash: hashPayload(step.inputs),
  };
}

export function stepSucceededPayload(
  latency_ms: number,
  outputs: unknown,
): Record<string, unknown> {
  return {
    latency_ms,
    outputs_hash: hashPayload(outputs),
  };
}

export function stepFailedPayload(
  result: DispatchFailure,
  attempt = 1,
): Record<string, unknown> {
  return {
    error_text: result.error.message,
    error_code: result.error.code,
    retryable: isRetryableDispatchFailure(result),
    attempt,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
