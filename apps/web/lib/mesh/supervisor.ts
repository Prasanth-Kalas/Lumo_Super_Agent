import type { Registry } from "../agent-registry.ts";
import type { AgentTimingRecorder } from "../perf/timing-spans.ts";
import { SubAgent } from "./subagent-base.ts";
import type {
  MeshContext,
  MeshTurnSummary,
  SubAgentInvocationResult,
  SubagentDispatchPlan,
} from "./types.ts";

export interface SupervisorInput {
  requestId: string;
  userId: string;
  sessionId: string;
  query: string;
  registry: Registry;
  installedAgentIds: string[];
  connectedAgentIds: string[];
  dispatchPlan: SubagentDispatchPlan;
  timing?: AgentTimingRecorder;
}

export interface MeshSubagentInput {
  query: string;
  userId: string;
  registry: Registry;
  installedAgentIds: string[];
  connectedAgentIds: string[];
}

export class SupervisorOrchestrator {
  private readonly subagents: Map<string, SubAgent<MeshSubagentInput, any>>;

  constructor(subagents: Array<SubAgent<MeshSubagentInput, any>> = []) {
    this.subagents = new Map(subagents.map((agent) => [agent.name, agent]));
  }

  async run(input: SupervisorInput): Promise<MeshTurnSummary> {
    const context: MeshContext = {
      requestId: input.requestId,
      userId: input.userId,
      sessionId: input.sessionId,
      now: new Date(),
      bucket: input.dispatchPlan.bucket,
    };
    const sharedInput: MeshSubagentInput = {
      query: input.query,
      userId: input.userId,
      registry: input.registry,
      installedAgentIds: input.installedAgentIds,
      connectedAgentIds: input.connectedAgentIds,
    };
    const invocations = input.dispatchPlan.agents.map(async (target) => {
      const agent = this.subagents.get(target.name);
      if (!agent) {
        return missingSubagent(target.name, target.model);
      }
      const span = input.timing?.start("intelligence_pass", {
        pass: "mesh_subagent",
        subagent_name: target.name,
        model_tier: target.model,
        required: target.required,
      });
      try {
        const result = await agent.invoke(sharedInput, context);
        await span?.end({
          status: result.status,
          latency_ms: result.latencyMs,
          error_code: result.errorCode,
        });
        return result;
      } catch (error) {
        await span?.end({
          status: "error",
          error_code: error instanceof Error ? error.name : "unknown_error",
        });
        throw error;
      }
    });

    const settled = await Promise.allSettled(invocations);
    const results = settled.map((entry, index) => {
      if (entry.status === "fulfilled") return entry.value;
      const target = input.dispatchPlan.agents[index];
      return missingSubagent(
        target?.name ?? "unknown",
        target?.model ?? "fast",
        entry.reason,
      );
    });
    return {
      requestId: input.requestId,
      plan: input.dispatchPlan,
      results,
      contextSummary: buildMeshContextSummary(results),
    };
  }
}

export function buildMeshContextSummary(
  results: Array<SubAgentInvocationResult>,
): string {
  const useful = results
    .filter((result) => result.status === "completed" || result.status === "fallback")
    .map((result) => `- ${result.subagentName}: ${result.outputSummary}`)
    .join("\n");
  if (!useful) return "No mesh sub-agent context was available for this turn.";
  return `Mesh sub-agent context:\n${useful}`;
}

function missingSubagent(
  name: string,
  modelUsed: string,
  error?: unknown,
): SubAgentInvocationResult {
  const now = new Date().toISOString();
  return {
    subagentName: name,
    modelUsed: modelUsed === "reflex" || modelUsed === "fast" || modelUsed === "reasoning"
      ? modelUsed
      : "fast",
    status: "failed",
    startedAt: now,
    endedAt: now,
    latencyMs: 0,
    result: null,
    errorCode: error instanceof Error ? error.name : "subagent_unavailable",
    outputSummary: `${name} unavailable`,
  };
}
