/**
 * Compatibility route for the PERM-1 spec shape:
 * POST /api/admin/agents/:agent_id/kill
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { setAgentKillSwitch } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { agent_id: string };
}

interface Body {
  reason?: unknown;
  severity?: unknown;
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return json({ error: "missing_reason" }, 400);
  const severity = body.severity;
  if (
    severity !== undefined &&
    severity !== "critical" &&
    severity !== "high" &&
    severity !== "medium" &&
    severity !== "low"
  ) {
    return json({ error: "invalid_severity" }, 400);
  }

  const agentId = decodeURIComponent(ctx.params.agent_id).trim();
  if (!agentId) return json({ error: "missing_agent_id" }, 400);

  await setAgentKillSwitch({
    switchType: "agent",
    agentId,
    reason,
    severity: severity ?? "high",
    createdBy: user.email ?? user.id,
  });

  return json({
    killed: true,
    agent_id: agentId,
    propagation_eta_seconds: 5,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
