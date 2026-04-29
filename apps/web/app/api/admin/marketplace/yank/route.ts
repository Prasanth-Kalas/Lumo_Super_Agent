import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { yankAgentVersion } from "@/lib/marketplace/version-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  agent_id?: unknown;
  version?: unknown;
  reason?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const version = typeof body.version === "string" ? body.version.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!agentId) return json({ error: "missing_agent_id" }, 400);
  if (!version) return json({ error: "missing_version" }, 400);
  if (!reason) return json({ error: "missing_reason" }, 400);

  try {
    const result = await yankAgentVersion({
      agentId,
      version,
      reason,
      yankedBy: user.id,
    });
    return json({ ok: true, yank: result });
  } catch (err) {
    return json(
      {
        error: "version_yank_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
