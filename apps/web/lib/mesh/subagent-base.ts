import { createHash } from "node:crypto";
import { getSupabase } from "../db.ts";
import { sanitizeTimingMetadata } from "../perf/timing-spans.ts";
import type {
  MeshContext,
  MeshModelTier,
  SubAgentInvocationResult,
  SubagentStatus,
} from "./types.ts";

export interface SubAgentInvokeOptions {
  parentCallId?: string | null;
}

export interface SubAgentConfig<Input, Output> {
  name: string;
  model: MeshModelTier;
  timeoutMs: number;
  run: (input: Input, context: MeshContext) => Promise<Output>;
  fallback?: (input: Input, context: MeshContext, error: unknown) => Promise<Output>;
  summarize?: (output: Output) => string;
}

export class SubAgent<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly model: MeshModelTier;
  readonly timeoutMs: number;
  private readonly runImpl: SubAgentConfig<Input, Output>["run"];
  private readonly fallbackImpl: SubAgentConfig<Input, Output>["fallback"];
  private readonly summarizeImpl: NonNullable<SubAgentConfig<Input, Output>["summarize"]>;

  constructor(config: SubAgentConfig<Input, Output>) {
    this.name = config.name;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.runImpl = config.run;
    this.fallbackImpl = config.fallback;
    this.summarizeImpl = config.summarize ?? defaultSummary;
  }

  async invoke(
    input: Input,
    context: MeshContext,
    options: SubAgentInvokeOptions = {},
  ): Promise<SubAgentInvocationResult<Output>> {
    const startedAt = new Date();
    let status: SubagentStatus = "completed";
    let result: Output | null = null;
    let errorCode: string | undefined;

    try {
      result = await withTimeout(
        () => this.runImpl(input, context),
        this.timeoutMs,
        `${this.name}_timeout`,
      );
    } catch (error) {
      status = isTimeoutError(error) ? "timeout" : "failed";
      errorCode = error instanceof Error ? error.name : "subagent_error";
      if (this.fallbackImpl) {
        try {
          result = await this.fallbackImpl(input, context, error);
          status = "fallback";
          errorCode = undefined;
        } catch (fallbackError) {
          errorCode =
            fallbackError instanceof Error
              ? fallbackError.name
              : "subagent_fallback_error";
        }
      }
    }

    const endedAt = new Date();
    const outputSummary =
      result === null
        ? `${this.name} ${status}`
        : this.summarizeImpl(result).slice(0, 2000);
    const invocation: SubAgentInvocationResult<Output> = {
      subagentName: this.name,
      modelUsed: this.model,
      status,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      latencyMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      result,
      errorCode,
      outputSummary,
    };
    await recordSubagentCall({
      requestId: context.requestId,
      parentCallId: options.parentCallId ?? null,
      subagentName: this.name,
      modelUsed: this.model,
      startedAt,
      endedAt,
      inputHash: hashInput(input),
      outputSummary,
      status,
      metadata: {
        bucket: context.bucket,
        error_code: errorCode,
        latency_ms: invocation.latencyMs,
      },
    });
    return invocation;
  }
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  errorName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${errorName}:${timeoutMs}`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function hashInput(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function defaultSummary(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const keys = Object.keys(record).slice(0, 8);
    return `object:${keys.join(",")}`;
  }
  return String(output ?? "null");
}

async function recordSubagentCall(input: {
  requestId: string;
  parentCallId: string | null;
  subagentName: string;
  modelUsed: string;
  startedAt: Date;
  endedAt: Date;
  inputHash: string;
  outputSummary: string;
  status: SubagentStatus;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from("subagent_calls").insert({
    request_id: input.requestId,
    parent_call_id: input.parentCallId,
    subagent_name: input.subagentName,
    model_used: input.modelUsed,
    started_at: input.startedAt.toISOString(),
    ended_at: input.endedAt.toISOString(),
    input_hash: input.inputHash,
    output_summary: input.outputSummary,
    status: input.status,
    metadata: sanitizeTimingMetadata(input.metadata),
  });
  if (error) {
    console.warn("[mesh] subagent_calls insert failed", {
      subagent_name: input.subagentName,
      error: error.message,
    });
  }
}
