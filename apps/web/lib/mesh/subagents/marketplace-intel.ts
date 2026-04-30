import {
  describeRegistryAgents,
  evaluateRiskBadgesForAgents,
  rankAgentsForIntent,
} from "../../marketplace-intelligence.ts";
import { SubAgent } from "../subagent-base.ts";
import type { MeshSubagentInput } from "../supervisor.ts";

export interface MarketplaceIntelResult {
  rankedAgents: Array<{
    agent_id: string;
    display_name: string;
    score: number;
    reasons: string[];
    risk_level?: string;
  }>;
  missingCapabilities: string[];
  source: string;
}

export function createMarketplaceIntelSubAgent(): SubAgent<MeshSubagentInput, MarketplaceIntelResult> {
  return new SubAgent<MeshSubagentInput, MarketplaceIntelResult>({
    name: "marketplace-intel",
    model: "fast",
    timeoutMs: 900,
    run: async (input) => {
      const installed = new Set(input.installedAgentIds);
      const descriptors = describeRegistryAgents(input.registry, installed);
      if (descriptors.length === 0) {
        return { rankedAgents: [], missingCapabilities: [], source: "empty" };
      }
      const [ranked, risks] = await Promise.all([
        rankAgentsForIntent({
          user_id: input.userId,
          user_intent: input.query,
          agents: descriptors,
          installed_agent_ids: input.installedAgentIds,
          limit: 6,
        }),
        evaluateRiskBadgesForAgents({
          user_id: input.userId,
          agents: descriptors.slice(0, 12),
        }),
      ]);
      return {
        rankedAgents: ranked.ranked_agents.slice(0, 6).map((agent) => ({
          ...agent,
          risk_level: risks.get(agent.agent_id)?.level,
        })),
        missingCapabilities: ranked.missing_capabilities,
        source: ranked.source,
      };
    },
    fallback: async (input) => {
      const descriptors = describeRegistryAgents(input.registry, new Set(input.installedAgentIds));
      return {
        rankedAgents: descriptors.slice(0, 6).map((agent, index) => ({
          agent_id: agent.agent_id,
          display_name: agent.display_name,
          score: Math.max(0.1, 0.7 - index * 0.08),
          reasons: ["Registry fallback ranking"],
          risk_level: "low",
        })),
        missingCapabilities: [],
        source: "fallback",
      };
    },
    summarize: (result) =>
      result.rankedAgents.length
        ? `top agents: ${result.rankedAgents.map((agent) => agent.agent_id).join(", ")}`
        : "no matching marketplace agents",
  });
}
