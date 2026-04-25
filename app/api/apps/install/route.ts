/**
 * /api/apps/install — install/remove connectionless Lumo apps.
 *
 * OAuth apps are installed as part of /api/connections/callback because the
 * consent grant is the install action. Public/no-auth apps need an explicit
 * install toggle so the orchestrator can avoid offering every public tool to
 * every signed-in user by default.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { ensureRegistry } from "@/lib/agent-registry";
import {
  permissionSnapshotForManifest,
  revokeAgentInstall,
  upsertAgentInstall,
} from "@/lib/app-installs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  agent_id?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const agent_id = await readAgentId(req);
  if (!agent_id) return json({ error: "missing_agent_id" }, 400);

  const entry = await findAgent(agent_id);
  if (!entry) return json({ error: "unknown_agent" }, 404);
  if (entry.manifest.connect.model === "oauth2") {
    return json(
      {
        error: "oauth_required",
        detail: "Connect this app through OAuth instead of installing directly.",
      },
      400,
    );
  }

  const install = await upsertAgentInstall({
    user_id: user.id,
    agent_id,
    permissions: permissionSnapshotForManifest(entry.manifest),
    install_source: "marketplace",
  });
  return json({ install });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const agent_id = await readAgentId(req);
  if (!agent_id) return json({ error: "missing_agent_id" }, 400);

  await revokeAgentInstall(user.id, agent_id);
  return json({ revoked: true });
}

async function readAgentId(req: NextRequest): Promise<string> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return "";
  }
  return typeof body.agent_id === "string" ? body.agent_id.trim() : "";
}

async function findAgent(agent_id: string) {
  const registry = await ensureRegistry();
  return (
    Object.values(registry.agents).find((a) => a.manifest.agent_id === agent_id) ??
    null
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
