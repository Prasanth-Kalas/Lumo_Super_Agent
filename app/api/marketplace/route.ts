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
import { ensureRegistry, healthyBridge } from "@/lib/agent-registry";
import { listConnectionsForUser, type ConnectionMeta } from "@/lib/connections";
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
  listing: AgentManifest["listing"] | null;
  connect_model: AgentManifest["connect"]["model"];
  required_scopes: Array<{ name: string; description: string }>;
  health_score: number;
  connection?: {
    id: string;
    status: ConnectionMeta["status"];
    connected_at: string;
    last_used_at: string | null;
  } | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const registry = await ensureRegistry();
  const user = await getServerUser();
  const connections = user ? await listConnectionsForUser(user.id) : [];
  const connByAgent = new Map<string, ConnectionMeta>();
  for (const c of connections) {
    if (c.status === "active") {
      connByAgent.set(c.agent_id, c);
    }
  }

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
      connection: conn
        ? {
            id: conn.id,
            status: conn.status,
            connected_at: conn.connected_at,
            last_used_at: conn.last_used_at,
          }
        : null,
    };
  });

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
