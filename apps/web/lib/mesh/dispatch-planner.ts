import type { IntentClassification } from "../perf/intent-classifier.ts";
import type {
  MeshModelTier,
  SubagentDispatchPlan,
  SubagentDispatchTarget,
} from "./types.ts";

export interface DispatchPlannerInput {
  classification: IntentClassification;
  userId: string;
  lastUserMessage: string;
  installedAgentCount: number;
  connectedAgentCount: number;
  hasRegistryAgents: boolean;
}

export function planSubagentsForTurn(
  input: DispatchPlannerInput,
): SubagentDispatchPlan {
  const text = input.lastUserMessage.toLowerCase();
  const agents: SubagentDispatchTarget[] = [];

  if (input.userId !== "anon") {
    agents.push(target("memory-retrieval", "fast", "Retrieve profile, facts, and preferences.", true, 800));
  }

  if (input.classification.bucket !== "fast_path" || looksLikeTravel(text)) {
    agents.push(target("intent-deep", "reflex", "Extract structured intent slots for the supervisor.", true, 500));
  }

  if (input.hasRegistryAgents && (looksLikeMarketplace(text) || input.installedAgentCount > 0)) {
    agents.push(target("marketplace-intel", "fast", "Rank relevant agents and surface trust/capability context.", false, 900));
  }

  if (input.userId !== "anon" && (looksLikeRecall(text) || input.classification.bucket === "reasoning_path")) {
    agents.push(target("archive-recall", "fast", "Recall indexed user/workspace history relevant to the turn.", false, 900));
  }

  return {
    bucket: input.classification.bucket,
    agents: dedupeTargets(agents),
  };
}

export function attachDispatchPlan(
  classification: IntentClassification,
  input: Omit<DispatchPlannerInput, "classification">,
): IntentClassification {
  return {
    ...classification,
    subagentDispatchPlan: planSubagentsForTurn({ classification, ...input }),
  };
}

function target(
  name: string,
  model: MeshModelTier,
  reason: string,
  required: boolean,
  timeoutMs: number,
): SubagentDispatchTarget {
  return { name, model, reason, required, timeoutMs };
}

function dedupeTargets(targets: SubagentDispatchTarget[]): SubagentDispatchTarget[] {
  const seen = new Set<string>();
  const out: SubagentDispatchTarget[] = [];
  for (const entry of targets) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out.slice(0, 6);
}

function looksLikeTravel(text: string): boolean {
  return /\b(flight|fly|airport|airline|vegas|trip|travel|hotel|cab|ride|book|reservation)\b/.test(text);
}

function looksLikeMarketplace(text: string): boolean {
  return /\b(agent|app|marketplace|install|connect|capability|tool|flight|hotel|ride|food|event)\b/.test(text);
}

function looksLikeRecall(text: string): boolean {
  return /\b(remember|last time|previous|earlier|my preference|my usual|home|work|profile)\b/.test(text);
}
