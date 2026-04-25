/**
 * POST /api/lumo/mission/install
 *
 * User-approved install action from the inline Lumo mission card. This is
 * deliberately separate from /api/apps/install so we can persist the mission
 * permission snapshot that explains why the app gained access.
 */

import type { NextRequest } from "next/server";
import { ensureRegistry } from "@/lib/agent-registry";
import { AuthError, requireServerUser } from "@/lib/auth";
import {
  permissionSnapshotForManifest,
  upsertAgentInstall,
} from "@/lib/app-installs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  agent_id?: unknown;
  mission_id?: unknown;
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

    const agent_id =
      typeof body.agent_id === "string" ? body.agent_id.trim() : "";
    if (!agent_id) return json({ error: "missing_agent_id" }, 400);

    const registry = await ensureRegistry();
    const entry =
      Object.values(registry.agents).find(
        (a) => a.manifest.agent_id === agent_id,
      ) ?? null;
    if (!entry) return json({ error: "unknown_agent" }, 404);

    const manifest = entry.manifest;
    if (manifest.connect.model === "oauth2") {
      return json(
        {
          error: "oauth_required",
          agent_id,
          detail:
            "This app must be connected through OAuth before Lumo can use it.",
        },
        409,
      );
    }

    const approvedFields = approvedProfileFields(
      body.profile_fields_approved,
      manifest.pii_scope,
    );
    const permissions = {
      ...permissionSnapshotForManifest(manifest),
      lumo: {
        mission_id:
          typeof body.mission_id === "string" ? body.mission_id.trim() : null,
        original_request:
          typeof body.original_request === "string"
            ? body.original_request.slice(0, 500)
            : null,
        profile_fields_approved: approvedFields,
        approved_at: new Date().toISOString(),
      },
    };

    const install = await upsertAgentInstall({
      user_id: user.id,
      agent_id,
      permissions,
      install_source: "lumo",
    });

    return json({
      install,
      agent: {
        agent_id,
        display_name: manifest.display_name,
        connect_model: manifest.connect.model,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: err.code, detail: err.message }, 401);
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

function approvedProfileFields(
  input: unknown,
  manifestFields: string[],
): string[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(manifestFields);
  return input.filter((field): field is string => {
    return typeof field === "string" && allowed.has(field);
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
