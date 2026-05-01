import type { NextRequest } from "next/server";
import { AuthError, requireServerUser } from "@/lib/auth";
import { isFirstPartyAgentId } from "@/lib/session-app-approvals";
import { revokeUserAppApproval } from "@/lib/user-app-approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  agent_id?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  let user_id: string;
  try {
    const user = await requireServerUser();
    user_id = user.id;
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: err.code }, err.code === "not_authenticated" ? 401 : 403);
    }
    throw err;
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const agent_id = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!agent_id) return json({ error: "missing_agent_id" }, 400);
  if (!isFirstPartyAgentId(agent_id)) {
    return json(
      {
        error: "not_first_party_app",
        detail: "Only first-party Lumo app approvals can be revoked here.",
      },
      400,
    );
  }

  const approval = await revokeUserAppApproval(user_id, agent_id);
  if (!approval) return json({ error: "not_found" }, 404);

  return json({
    ok: true,
    approval: {
      agent_id: approval.agent_id,
      revoked_at: approval.revoked_at,
    },
  });
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
