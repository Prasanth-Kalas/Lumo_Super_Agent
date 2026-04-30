import { recallFromArchive, shouldRunArchiveRecall } from "../../archive-recall.ts";
import { SubAgent } from "../subagent-base.ts";
import type { MeshSubagentInput } from "../supervisor.ts";

export interface ArchiveRecallSubAgentResult {
  status: string;
  source: string;
  hitCount: number;
  summary: string;
  error?: string;
}

export function createArchiveRecallSubAgent(): SubAgent<MeshSubagentInput, ArchiveRecallSubAgentResult> {
  return new SubAgent<MeshSubagentInput, ArchiveRecallSubAgentResult>({
    name: "archive-recall",
    model: "fast",
    timeoutMs: 900,
    run: async (input) => {
      if (!input.userId || input.userId === "anon" || !shouldRunArchiveRecall(input.query)) {
        return {
          status: "skipped",
          source: "none",
          hitCount: 0,
          summary: "Archive recall not required for this turn.",
        };
      }
      const recall = await recallFromArchive({
        user_id: input.userId,
        query: input.query,
        topK: 5,
        recordUsage: true,
      });
      return {
        status: recall.status,
        source: recall.source,
        hitCount: recall.hits.length,
        summary: recall.summary,
        error: recall.error,
      };
    },
    fallback: async () => ({
      status: "fallback",
      source: "fallback",
      hitCount: 0,
      summary: "Archive recall unavailable.",
      error: "fallback",
    }),
    summarize: (result) =>
      `${result.status}/${result.source}; ${result.hitCount} hits; ${result.summary.slice(0, 180)}`,
  });
}
