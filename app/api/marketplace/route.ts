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
  connect_model: AgentManifest["connect"]["model"] | "mcp_bearer" | "mcp_none";
  required_scopes: Array<{ name: string; description: string }>;
  health_score: number;
  /** "lumo" for native agents, "mcp" for MCP-backed entries. */
  source: "lumo" | "mcp";
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
}

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

  const agents: MarketplaceAgent[] = Object.values(registry.agents).map((e) => {
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
