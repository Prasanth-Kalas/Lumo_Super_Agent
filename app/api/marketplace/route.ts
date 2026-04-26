/**
 * GET /api/marketplace
 *
 * Public (auth optional) catalog feed. Returns the set of agents the
 * Super Agent has loaded from its registry, filtered to healthy ones,
 * shaped for UI consumption.
 *
 * If the caller IS authenticated, we also annotate each agent with the
 * current user's connection status so the client doesn't have to make a
 * second request to render Connect vs. Connected.
 */

import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { ensureRegistry } from "@/lib/agent-registry";
import { listConnectionsForUser, type ConnectionMeta } from "@/lib/connections";
import { listInstalledAgentsForUser, type AppInstall } from "@/lib/app-installs";
import {
  loadMcpCatalog,
  listMcpConnectionsForUser,
} from "@/lib/mcp/registry";
import type { AgentManifest } from "@lumo/agent-sdk";
import {
  evaluateRiskBadgesForAgents,
  fallbackRiskBadgeForAgent,
  type IntelligenceAgentDescriptor,
  type RiskBadge,
} from "@/lib/marketplace-intelligence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MarketplaceAgent {
  agent_id: string;
  display_name: string;
  one_liner: string;
  domain: string;
  version: string;
  intents: string[];
  listing: NonNullable<AgentManifest["listing"]> | null;
  connect_model:
    | AgentManifest["connect"]["model"]
    | "mcp_bearer"
    | "mcp_none"
    | "coming_soon";
  required_scopes: Array<{ name: string; description: string }>;
  health_score: number;
  /** "lumo" for native agents, "mcp" for MCP-backed, "coming_soon" for placeholders. */
  source: "lumo" | "mcp" | "coming_soon";
  pii_scope?: AgentManifest["pii_scope"];
  requires_payment?: boolean;
  /** Set on coming_soon entries — explains current status to the UI. */
  coming_soon?: {
    status: "in_review" | "planned";
    eta_label: string;
    rationale: string;
  };
  connection?: {
    id: string;
    status: ConnectionMeta["status"] | "active";
    connected_at: string;
    last_used_at: string | null;
  } | null;
  install?: {
    status: AppInstall["status"];
    installed_at: string;
    last_used_at: string | null;
  } | null;
  risk_badge: RiskBadge;
}

/**
 * Coming-soon tiles for V1.x platforms whose connectors aren't live yet.
 *
 * Marketing surface: shows the user that Lumo is wiring these up,
 * sets expectations on timeline, and reduces "is this a YouTube-only
 * dashboard?" confusion. The Connect button is disabled — UI renders
 * the eta_label pill instead.
 *
 * When a connector ships, remove its entry here AND make sure the
 * registry exposes the real entry; if both ship simultaneously the
 * coming_soon tile is suppressed below.
 */
const COMING_SOON_TILES: MarketplaceAgent[] = [
  {
    agent_id: "coming-soon:meta-instagram",
    display_name: "Instagram",
    one_liner:
      "Pull post analytics, manage comments, and publish — gated by your confirmation card.",
    domain: "personal",
    version: "v1.2",
    intents: [],
    listing: {
      category: "Creator",
      pricing_note: "Free · in Meta App Review",
      logo_url: "/logos/instagram.svg",
    } as NonNullable<AgentManifest["listing"]>,
    connect_model: "coming_soon",
    required_scopes: [],
    health_score: 1,
    source: "coming_soon",
    risk_badge: fallbackRiskBadgeForAgent({
      agent_id: "coming-soon:meta-instagram",
      display_name: "Instagram",
      domain: "personal",
      category: "Creator",
      one_liner:
        "Pull post analytics, manage comments, and publish — gated by your confirmation card.",
      intents: [],
      scopes: [],
      installed: false,
      connect_model: "coming_soon",
      source: "coming_soon",
    }),
    coming_soon: {
      status: "in_review",
      eta_label: "Coming soon — in review",
      rationale: "Meta App Review (~2–4 weeks). All scopes added; demo videos pending.",
    },
  },
  {
    agent_id: "coming-soon:meta-facebook",
    display_name: "Facebook Pages",
    one_liner: "Page insights + post management + comment replies, all gated.",
    domain: "personal",
    version: "v1.3",
    intents: [],
    listing: {
      category: "Creator",
      pricing_note: "Free · in Meta App Review",
      logo_url: "/logos/facebook.svg",
    } as NonNullable<AgentManifest["listing"]>,
    connect_model: "coming_soon",
    required_scopes: [],
    health_score: 1,
    source: "coming_soon",
    risk_badge: fallbackRiskBadgeForAgent({
      agent_id: "coming-soon:meta-facebook",
      display_name: "Facebook Pages",
      domain: "personal",
      category: "Creator",
      one_liner: "Page insights + post management + comment replies, all gated.",
      intents: [],
      scopes: [],
      installed: false,
      connect_model: "coming_soon",
      source: "coming_soon",
    }),
    coming_soon: {
      status: "in_review",
      eta_label: "Coming soon — in review",
      rationale: "Same Meta App Review pass as Instagram.",
    },
  },
  {
    agent_id: "coming-soon:linkedin",
    display_name: "LinkedIn",
    one_liner:
      "Personal post + analytics + comment management for executives and creators.",
    domain: "personal",
    version: "v1.4",
    intents: [],
    listing: {
      category: "Creator",
      pricing_note: "Free · LinkedIn MDP review pending",
      logo_url: "/logos/linkedin.svg",
    } as NonNullable<AgentManifest["listing"]>,
    connect_model: "coming_soon",
    required_scopes: [],
    health_score: 1,
    source: "coming_soon",
    risk_badge: fallbackRiskBadgeForAgent({
      agent_id: "coming-soon:linkedin",
      display_name: "LinkedIn",
      domain: "personal",
      category: "Creator",
      one_liner:
        "Personal post + analytics + comment management for executives and creators.",
      intents: [],
      scopes: [],
      installed: false,
      connect_model: "coming_soon",
      source: "coming_soon",
    }),
    coming_soon: {
      status: "in_review",
      eta_label: "Coming soon — pending MDP",
      rationale: "LinkedIn Marketing Developer Platform approval (~4–8 weeks).",
    },
  },
  {
    agent_id: "coming-soon:newsletter",
    display_name: "Newsletter (Beehiiv · Mailchimp · Substack)",
    one_liner: "Subscriber count, open rate, top issues — alongside your social.",
    domain: "personal",
    version: "v1.1",
    intents: [],
    listing: {
      category: "Creator",
      pricing_note: "Free",
      logo_url: "/logos/newsletter.svg",
    } as NonNullable<AgentManifest["listing"]>,
    connect_model: "coming_soon",
    required_scopes: [],
    health_score: 1,
    source: "coming_soon",
    risk_badge: fallbackRiskBadgeForAgent({
      agent_id: "coming-soon:newsletter",
      display_name: "Newsletter (Beehiiv · Mailchimp · Substack)",
      domain: "personal",
      category: "Creator",
      one_liner: "Subscriber count, open rate, top issues — alongside your social.",
      intents: [],
      scopes: [],
      installed: false,
      connect_model: "coming_soon",
      source: "coming_soon",
    }),
    coming_soon: {
      status: "planned",
      eta_label: "Coming next sprint",
      rationale: "Beehiiv + Mailchimp APIs are simple OAuth/API key. Substack via RSS read-only.",
    },
  },
  {
    agent_id: "coming-soon:x",
    display_name: "X (Twitter)",
    one_liner: "Reads + posting once X API pricing makes V1 economics work.",
    domain: "personal",
    version: "v2",
    intents: [],
    listing: {
      category: "Creator",
      pricing_note: "Deferred · API tier review",
      logo_url: "/logos/x.svg",
    } as NonNullable<AgentManifest["listing"]>,
    connect_model: "coming_soon",
    required_scopes: [],
    health_score: 1,
    source: "coming_soon",
    risk_badge: fallbackRiskBadgeForAgent({
      agent_id: "coming-soon:x",
      display_name: "X (Twitter)",
      domain: "personal",
      category: "Creator",
      one_liner: "Reads + posting once X API pricing makes V1 economics work.",
      intents: [],
      scopes: [],
      installed: false,
      connect_model: "coming_soon",
      source: "coming_soon",
    }),
    coming_soon: {
      status: "planned",
      eta_label: "V2 — TBD",
      rationale:
        "X API Basic tier is $200/mo and excludes analytics. Holding until budget or pricing improves.",
    },
  },
];

export async function GET(_req: NextRequest): Promise<Response> {
  const registry = await ensureRegistry();
  const user = await getServerUser();
  const connections = user ? await listConnectionsForUser(user.id) : [];
  const installs = user ? await listInstalledAgentsForUser(user.id) : [];
  const connByAgent = new Map<string, ConnectionMeta>();
  for (const c of connections) {
    if (c.status === "active") {
      connByAgent.set(c.agent_id, c);
    }
  }
  const installByAgent = new Map(
    installs.filter((i) => i.status === "installed").map((i) => [i.agent_id, i]),
  );

  const agents: MarketplaceAgent[] = Object.values(registry.agents)
    .filter((e) => e.system !== true)
    .map((e) => {
      const m = e.manifest;
      const connect = m.connect;
      const required_scopes =
        connect.model === "oauth2"
          ? connect.scopes
              .filter((s) => s.required)
              .map(({ name, description }) => ({ name, description }))
          : [];
      const conn = connByAgent.get(m.agent_id) ?? null;
      const install = installByAgent.get(m.agent_id) ?? null;

      return {
        agent_id: m.agent_id,
        display_name: m.display_name,
        one_liner: m.one_liner,
        domain: m.domain,
        version: m.version,
        intents: m.intents,
        listing: m.listing ?? null,
        connect_model: connect.model,
        required_scopes,
        health_score: e.health_score,
        source: "lumo",
        pii_scope: m.pii_scope,
        requires_payment: m.requires_payment,
        risk_badge: fallbackRiskBadgeForAgent(describeMarketplaceAgentForRisk({
          agent_id: m.agent_id,
          display_name: m.display_name,
          one_liner: m.one_liner,
          domain: m.domain,
          version: m.version,
          intents: m.intents,
          listing: m.listing ?? null,
          connect_model: connect.model,
          required_scopes,
          health_score: e.health_score,
          source: "lumo",
          pii_scope: m.pii_scope,
          requires_payment: m.requires_payment,
          connection: conn
            ? {
                id: conn.id,
                status: conn.status,
                connected_at: conn.connected_at,
                last_used_at: conn.last_used_at,
              }
            : null,
          install: install
            ? {
                status: install.status,
                installed_at: install.installed_at,
                last_used_at: install.last_used_at,
              }
            : conn
              ? {
                  status: "installed",
                  installed_at: conn.connected_at,
                  last_used_at: conn.last_used_at,
                }
              : null,
        })),
        connection: conn
          ? {
              id: conn.id,
              status: conn.status,
              connected_at: conn.connected_at,
              last_used_at: conn.last_used_at,
            }
          : null,
        install: install
          ? {
              status: install.status,
              installed_at: install.installed_at,
              last_used_at: install.last_used_at,
            }
          : conn
            ? {
                status: "installed",
                installed_at: conn.connected_at,
                last_used_at: conn.last_used_at,
              }
            : null,
      };
    });

  // MCP-backed entries. Merge alongside native agents so the
  // /marketplace and /onboarding grids render both under one set
  // of affordances. `source: "mcp"` is the flag the UI uses to
  // render a "Powered by MCP" badge.
  const mcpCatalog = await loadMcpCatalog();
  const mcpConnections = user ? await listMcpConnectionsForUser(user.id) : [];
  const mcpConnByServer = new Map(mcpConnections.map((c) => [c.server_id, c]));

  for (const s of mcpCatalog) {
    const conn = mcpConnByServer.get(s.server_id) ?? null;
    agents.push({
      agent_id: `mcp:${s.server_id}`,
      display_name: s.display_name,
      one_liner: s.one_liner,
      domain: s.category ?? "MCP",
      version: "mcp",
      intents: [],
      listing: {
        category: s.category,
        logo_url: s.logo_url,
      } as NonNullable<AgentManifest["listing"]>,
      connect_model: s.auth_model === "bearer" ? "mcp_bearer" : "mcp_none",
      required_scopes: (s.scopes ?? []).map(({ name, description }) => ({
        name,
        description,
      })),
      // No health probe for MCP in Phase 1 — presence in the config
      // is the signal. Probing 20 MCPs per marketplace load is not
      // worth the latency until we have a cache.
      health_score: 1,
      source: "mcp",
      risk_badge: fallbackRiskBadgeForAgent({
        agent_id: `mcp:${s.server_id}`,
        display_name: s.display_name,
        domain: s.category ?? "MCP",
        category: s.category ?? "MCP",
        one_liner: s.one_liner,
        intents: [],
        scopes: (s.scopes ?? []).map((scope) => scope.name),
        installed: conn?.status === "active",
        connect_model: s.auth_model === "bearer" ? "mcp_bearer" : "mcp_none",
        health_score: 1,
        source: "mcp",
      }),
      connection: conn
        ? {
            id: conn.id,
            status: "active",
            connected_at: conn.connected_at,
            last_used_at: conn.last_used_at,
          }
        : null,
    });
  }

  // Coming-soon tiles for V1.x platforms whose connectors aren't live.
  // Suppressed if a real registry entry already exposes that platform —
  // we never want to show two tiles for the same logical platform. The
  // Meta tile in the registry covers BOTH instagram + facebook (one
  // OAuth grant under the umbrella Meta App), so suppress both
  // coming-soon variants when "meta" is registered.
  const realAgentIds = new Set(agents.map((a) => a.agent_id));
  const metaUmbrellaPresent = realAgentIds.has("meta");
  for (const tile of COMING_SOON_TILES) {
    const aliasedId = tile.agent_id.replace("coming-soon:", "");
    if (realAgentIds.has(aliasedId)) continue;
    if (metaUmbrellaPresent && (aliasedId === "meta-instagram" || aliasedId === "meta-facebook")) {
      continue;
    }
    agents.push(tile);
  }

  const riskInputs = agents.map(describeMarketplaceAgentForRisk);
  const riskBadges = await evaluateRiskBadgesForAgents({
    user_id: user?.id ?? "anon",
    agents: riskInputs,
  });
  for (const agent of agents) {
    agent.risk_badge =
      riskBadges.get(agent.agent_id) ??
      fallbackRiskBadgeForAgent(describeMarketplaceAgentForRisk(agent));
  }

  return new Response(
    JSON.stringify({
      agents,
      authenticated: !!user,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function describeMarketplaceAgentForRisk(
  agent: Omit<MarketplaceAgent, "risk_badge"> | MarketplaceAgent,
): IntelligenceAgentDescriptor {
  return {
    agent_id: agent.agent_id,
    display_name: agent.display_name,
    domain: agent.domain,
    category: agent.listing?.category ?? agent.domain,
    one_liner: agent.one_liner,
    intents: agent.intents,
    scopes: agent.required_scopes.map((scope) => scope.name),
    installed:
      agent.connection?.status === "active" || agent.install?.status === "installed",
    connect_model: agent.connect_model,
    requires_payment: agent.requires_payment ?? false,
    pii_scope: agent.pii_scope ?? [],
    health_score: agent.health_score,
    source: agent.source,
  };
}
