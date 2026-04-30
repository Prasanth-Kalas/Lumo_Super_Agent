import { createArchiveRecallSubAgent } from "./subagents/archive-recall.ts";
import { createIntentDeepSubAgent } from "./subagents/intent-deep.ts";
import { createMarketplaceIntelSubAgent } from "./subagents/marketplace-intel.ts";
import { createMemoryRetrievalSubAgent } from "./subagents/memory-retrieval.ts";
import type { SubAgent } from "./subagent-base.ts";
import type { MeshSubagentInput } from "./supervisor.ts";

export function createDefaultSubAgents(): Array<SubAgent<MeshSubagentInput, any>> {
  return [
    createMemoryRetrievalSubAgent(),
    createIntentDeepSubAgent(),
    createMarketplaceIntelSubAgent(),
    createArchiveRecallSubAgent(),
  ];
}
