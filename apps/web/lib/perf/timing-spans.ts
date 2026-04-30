import { randomUUID } from "node:crypto";
import { getSupabase } from "../db.ts";

export const AGENT_TIMING_PHASES = [
  "pre_llm_data_load",
  "intelligence_pass",
  "system_prompt_build",
  "llm_first_token",
  "llm_total",
  "tool_dispatch",
  "post_processing",
  "total",
] as const;

export type AgentTimingPhase = (typeof AGENT_TIMING_PHASES)[number];
export type AgentTimingBucket = "fast_path" | "tool_path" | "reasoning_path";
export type AgentTimingMetadata = Record<string, unknown>;

const SENSITIVE_METADATA_KEY_RE =
  /(prompt|message|content|body|text|token|secret|key|authorization|cookie|pii)/i;
const MAX_METADATA_KEYS = 40;
const MAX_METADATA_STRING = 256;
const MAX_METADATA_ARRAY = 20;
const MAX_METADATA_DEPTH = 3;

export function createTimingRequestId(sessionId: string): string {
  const safeSession = sessionId
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9:._-]/g, "_")
    .slice(0, 96);
  return `${safeSession || "session"}:${randomUUID()}`;
}

export function createAgentTimingRecorder({
  requestId,
  bucket = "reasoning_path",
}: {
  requestId: string;
  bucket?: AgentTimingBucket;
}): AgentTimingRecorder {
  return new AgentTimingRecorder(requestId, bucket);
}

export class AgentTimingRecorder {
  private currentBucket: AgentTimingBucket;
  readonly requestId: string;

  constructor(
    requestId: string,
    bucket: AgentTimingBucket = "reasoning_path",
  ) {
    this.requestId = requestId;
    this.currentBucket = bucket;
  }

  setBucket(bucket: AgentTimingBucket): void {
    this.currentBucket = bucket;
  }

  get bucket(): AgentTimingBucket {
    return this.currentBucket;
  }

  start(
    phase: AgentTimingPhase,
    metadata: AgentTimingMetadata = {},
  ): AgentTimingSpan {
    return new AgentTimingSpan({
      requestId: this.requestId,
      getBucket: () => this.currentBucket,
      phase,
      metadata,
    });
  }
}

export class AgentTimingSpan {
  private readonly startedAt = new Date();
  private ended = false;
  private readonly input: {
    requestId: string;
    getBucket: () => AgentTimingBucket;
    phase: AgentTimingPhase;
    metadata: AgentTimingMetadata;
  };

  constructor(input: {
      requestId: string;
      getBucket: () => AgentTimingBucket;
      phase: AgentTimingPhase;
      metadata: AgentTimingMetadata;
    }) {
    this.input = input;
  }

  async end(metadata: AgentTimingMetadata = {}): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const endedAt = new Date();
    await recordAgentTimingSpan({
      requestId: this.input.requestId,
      bucket: this.input.getBucket(),
      phase: this.input.phase,
      startedAt: this.startedAt,
      endedAt,
      metadata: {
        ...this.input.metadata,
        ...metadata,
      },
    });
  }
}

export async function withAgentTimingSpan<T>(
  recorder: AgentTimingRecorder,
  phase: AgentTimingPhase,
  metadata: AgentTimingMetadata,
  fn: () => Promise<T>,
  after?: (value: T) => AgentTimingMetadata,
): Promise<T> {
  const span = recorder.start(phase, metadata);
  try {
    const value = await fn();
    await span.end({ status: "ok", ...(after ? after(value) : {}) });
    return value;
  } catch (error) {
    await span.end({
      status: "error",
      error_code: error instanceof Error ? error.name : "unknown_error",
    });
    throw error;
  }
}

async function recordAgentTimingSpan({
  requestId,
  bucket,
  phase,
  startedAt,
  endedAt,
  metadata,
}: {
  requestId: string;
  bucket: AgentTimingBucket;
  phase: AgentTimingPhase;
  startedAt: Date;
  endedAt: Date;
  metadata: AgentTimingMetadata;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const cleanMetadata = sanitizeTimingMetadata(metadata);
  const { error } = await supabase.from("agent_request_timings").insert({
    request_id: requestId,
    bucket,
    phase,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    metadata: cleanMetadata,
  });
  if (error) {
    console.warn("[perf] agent_request_timings insert failed", {
      phase,
      bucket,
      error: error.message,
    });
  }
}

export function sanitizeTimingMetadata(
  metadata: AgentTimingMetadata,
): AgentTimingMetadata {
  return sanitizeObject(metadata, 0);
}

function sanitizeObject(
  value: Record<string, unknown>,
  depth: number,
): AgentTimingMetadata {
  const out: AgentTimingMetadata = {};
  for (const [key, raw] of Object.entries(value).slice(0, MAX_METADATA_KEYS)) {
    if (SENSITIVE_METADATA_KEY_RE.test(key)) continue;
    const clean = sanitizeValue(raw, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, MAX_METADATA_STRING);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (depth >= MAX_METADATA_DEPTH) return `[array:${value.length}]`;
    return value
      .slice(0, MAX_METADATA_ARRAY)
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    if (depth >= MAX_METADATA_DEPTH) return "[object]";
    return sanitizeObject(value as Record<string, unknown>, depth);
  }
  return undefined;
}
