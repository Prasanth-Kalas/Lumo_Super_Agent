/**
 * GET  /api/connections              → list current user's connections
 * POST /api/connections/disconnect   → revoke one (by connection_id)
 *
 * Both require an authenticated Lumo user (gated by middleware).
 *
 * These power the /connections page and the marketplace's per-agent
 * Connected/Disconnect badges. Metadata only — tokens never cross the
 * network boundary.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { listConnectionsForUser } from "@/lib/connections";
import { ensureRegistry } from "@/lib/agent-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const connections = await listConnectionsForUser(user.id);
  const registry = await ensureRegistry();
  const now = new Date(registry.loaded_at).toISOString();
  const systemConnections = Object.values(registry.agents)
    .filter((entry) => entry.system === true && entry.health_score >= 0.6)
    .map((entry) => ({
      id: `system:${entry.manifest.agent_id}`,
      agent_id: entry.manifest.agent_id,
      display_name: entry.manifest.display_name,
      one_liner: entry.manifest.one_liner,
      source: "system" as const,
      status: "active" as const,
      scopes: ["system"],
      expires_at: null,
      connected_at: now,
      last_used_at: null,
      revoked_at: null,
      updated_at: now,
    }));
  return json({ connections: [...systemConnections, ...connections] });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
