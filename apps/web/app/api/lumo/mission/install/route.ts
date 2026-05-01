/**
 * POST /api/lumo/mission/install
 *
 * User-approved install action from the inline Lumo mission card. This is
 * deliberately separate from /api/apps/install so we can persist the mission
 * permission snapshot that explains why the app gained access.
 */

import type { NextRequest } from "next/server";
import { AuthError, requireServerUser } from "@/lib/auth";
import {
  commitMissionInstallApproval,
  MissionInstallApprovalError,
} from "@/lib/mission-install-approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  agent_id?: unknown;
  approval_idempotency_key?: unknown;
  mission_id?: unknown;
  session_id?: unknown;
  original_request?: unknown;
  user_approved?: unknown;
  profile_fields_approved?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const user = await requireServerUser();
    const body = await readBody(req);
    if (!body) return json({ error: "invalid_json" }, 400);
    if (body.user_approved !== true) {
      return json(
        {
          error: "permission_required",
          detail: "Lumo installs require explicit user_approved: true.",
        },
        400,
      );
    }

    const result = await commitMissionInstallApproval({
      user_id: user.id,
      agent_id: typeof body.agent_id === "string" ? body.agent_id : "",
      approval_idempotency_key:
        typeof body.approval_idempotency_key === "string"
          ? body.approval_idempotency_key
          : null,
      mission_id: typeof body.mission_id === "string" ? body.mission_id : null,
      session_id: typeof body.session_id === "string" ? body.session_id : null,
      original_request:
        typeof body.original_request === "string" ? body.original_request : null,
      profile_fields_approved: body.profile_fields_approved,
    });

    return json({
      install: result.install,
      session_approval: result.session_approval
        ? {
            session_id: result.session_approval.session_id,
            agent_id: result.session_approval.agent_id,
            approved_at: result.session_approval.approved_at,
            connected_at: result.session_approval.connected_at,
            connection_provider: result.session_approval.connection_provider,
          }
        : null,
      agent: result.agent,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: err.code, detail: err.message }, 401);
    }
    if (err instanceof MissionInstallApprovalError) {
      return json({ error: err.code, detail: err.message }, err.status);
    }
    throw err;
  }
}

async function readBody(req: NextRequest): Promise<Body | null> {
  try {
    return (await req.json()) as Body;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
