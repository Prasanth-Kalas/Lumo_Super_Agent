/**
 * POST /api/lumo/mission
 *
 * Non-mutating marketplace discovery for the Lumo mission gate. Given a
 * user request, returns which apps are ready, which apps need permission, and
 * which capabilities are not yet available in the approved marketplace.
 */

import type { NextRequest } from "next/server";
import { ensureRegistry } from "@/lib/agent-registry";
import { getServerUser } from "@/lib/auth";
import { listConnectionsForUser } from "@/lib/connections";
import { listInstalledAgentsForUser } from "@/lib/app-installs";
import { buildLumoMissionPlan } from "@/lib/lumo-mission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  message?: unknown;
  messages?: Array<{ role?: unknown; content?: unknown }>;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const request = readMessage(body);
  if (!request) {
    return json({ error: "invalid_body", detail: "message is required" }, 400);
  }

  const user = await getServerUser();
  const user_id = user?.id ?? req.headers.get("x-lumo-user-id") ?? "anon";
  const registry = await ensureRegistry();
  const [connections, installs] =
    user_id && user_id !== "anon"
      ? await Promise.all([
          listConnectionsForUser(user_id),
          listInstalledAgentsForUser(user_id),
        ])
      : [[], []];

  const plan = buildLumoMissionPlan({
    request,
    registry,
    connections,
    installs,
    user_id,
  });

  return json({ plan, authenticated: !!user });
}

function readMessage(body: Body): string {
  if (typeof body.message === "string") return body.message.trim();
  const lastUser = body.messages
    ?.filter((m) => m.role === "user" && typeof m.content === "string")
    .at(-1)?.content;
  return typeof lastUser === "string" ? lastUser.trim() : "";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
