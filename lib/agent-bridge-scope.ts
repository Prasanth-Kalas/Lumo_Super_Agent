import type { BridgeResult } from "@lumo/agent-sdk";

export interface UserScopedAgentEntry {
  system?: boolean;
  health_score: number;
  manifest: {
    agent_id: string;
    connect: { model: string };
  };
}

/**
 * Pure bridge filter used by the orchestrator. Kept separate from
 * agent-registry.ts so the system-agent eligibility matrix is easy to
 * test without booting remote agents.
 */
export function filterBridgeForUser(
  base: BridgeResult,
  entries: Iterable<UserScopedAgentEntry>,
  connectedAgentIds: ReadonlySet<string>,
  installedAgentIds: ReadonlySet<string>,
  minScore: number,
  allowPublicWithoutInstall: boolean,
): BridgeResult {
  const eligibleAgents = new Set<string>();
  for (const e of entries) {
    if (e.health_score < minScore) continue;
    if (e.system === true) {
      if (!allowPublicWithoutInstall) {
        eligibleAgents.add(e.manifest.agent_id);
      }
      continue;
    }
    if (connectedAgentIds.has(e.manifest.agent_id)) {
      eligibleAgents.add(e.manifest.agent_id);
    } else if (installedAgentIds.has(e.manifest.agent_id)) {
      eligibleAgents.add(e.manifest.agent_id);
    } else if (allowPublicWithoutInstall && e.manifest.connect.model === "none") {
      eligibleAgents.add(e.manifest.agent_id);
    }
  }
  const filteredTools = base.tools.filter((t) => {
    const routing = base.routing[t.name];
    return routing ? eligibleAgents.has(routing.agent_id) : false;
  });
  const filteredRouting = Object.fromEntries(
    Object.entries(base.routing).filter(([, v]) =>
      eligibleAgents.has(v.agent_id),
    ),
  );
  return { tools: filteredTools, routing: filteredRouting };
}
