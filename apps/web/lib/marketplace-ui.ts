export type MarketplaceAgentSource = "lumo" | "mcp" | "coming_soon" | string;
export type MarketplaceSegment = "all" | "connected" | "available" | "review" | "mcp";

export interface MarketplaceAgentLike {
  agent_id: string;
  display_name: string;
  one_liner?: string | null;
  domain?: string | null;
  intents?: string[] | null;
  listing?: {
    category?: string | null;
  } | null;
  source?: MarketplaceAgentSource | null;
  connection?: {
    status?: string | null;
  } | null;
  install?: {
    status?: string | null;
  } | null;
}

export function isMarketplaceAgentConnected(agent: MarketplaceAgentLike): boolean {
  return (
    agent.connection?.status === "active" ||
    agent.install?.status === "installed"
  );
}

export function marketplaceCounts(agents: MarketplaceAgentLike[]) {
  let connected = 0;
  let available = 0;
  let review = 0;
  let mcp = 0;
  for (const agent of agents) {
    if (isMarketplaceAgentConnected(agent)) connected++;
    if (agent.source === "coming_soon") review++;
    else available++;
    if (agent.source === "mcp") mcp++;
  }
  return {
    total: agents.length,
    connected,
    available,
    review,
    mcp,
  };
}

export function marketplaceSegmentLabel(segment: MarketplaceSegment): string {
  switch (segment) {
    case "connected":
      return "Connected";
    case "available":
      return "Available";
    case "review":
      return "Review only";
    case "mcp":
      return "MCP";
    default:
      return "All";
  }
}

export function marketplaceAgentMatchesSegment(
  agent: MarketplaceAgentLike,
  segment: MarketplaceSegment,
): boolean {
  if (segment === "all") return true;
  if (segment === "connected") return isMarketplaceAgentConnected(agent);
  if (segment === "available") {
    return agent.source !== "coming_soon" && !isMarketplaceAgentConnected(agent);
  }
  if (segment === "review") return agent.source === "coming_soon";
  if (segment === "mcp") return agent.source === "mcp";
  return true;
}

export function marketplaceAgentMatchesQuery(
  agent: MarketplaceAgentLike,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [
    agent.display_name,
    agent.one_liner ?? "",
    agent.domain ?? "",
    agent.listing?.category ?? "",
    ...(agent.intents ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(normalized);
}

export function sortMarketplaceAgents<T extends MarketplaceAgentLike>(agents: T[]): T[] {
  return [...agents].sort((a, b) => {
    const rank = (agent: MarketplaceAgentLike) => {
      if (isMarketplaceAgentConnected(agent)) return 0;
      if (agent.source !== "coming_soon") return 1;
      return 2;
    };
    return rank(a) - rank(b) || a.display_name.localeCompare(b.display_name);
  });
}
