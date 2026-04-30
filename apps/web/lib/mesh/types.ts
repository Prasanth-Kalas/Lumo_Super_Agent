import type { AgentTimingBucket } from "../perf/timing-spans.ts";

export type MeshModelTier = "reflex" | "fast" | "reasoning";

export interface SubagentDispatchTarget {
  name: string;
  model: MeshModelTier;
  reason: string;
  required: boolean;
  timeoutMs?: number;
}

export interface SubagentDispatchPlan {
  bucket: AgentTimingBucket;
  agents: SubagentDispatchTarget[];
}

export type SubagentStatus =
  | "completed"
  | "failed"
  | "timeout"
  | "fallback"
  | "cancelled";

export interface MeshContext {
  requestId: string;
  userId: string;
  sessionId: string;
  now: Date;
  bucket: AgentTimingBucket;
}

export interface SubAgentInvocationResult<T = unknown> {
  subagentName: string;
  modelUsed: MeshModelTier;
  status: SubagentStatus;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  result: T | null;
  errorCode?: string;
  outputSummary: string;
}

export interface MeshTurnSummary {
  requestId: string;
  plan: SubagentDispatchPlan;
  results: Array<SubAgentInvocationResult>;
  contextSummary: string;
}
