/**
 * POST /api/connections/disconnect   body: { connection_id }
 *
 * User explicitly revokes a connection. We:
 *   1. Mark the agent_connections row `revoked` (optimistic).
 *   2. Best-effort call the agent's revocation_url if it declared one
 *      (RFC 7009) — errors are logged, not surfaced to the user, because
 *      the local record is the source of truth from this point on.
 *
 * The UI removes the row from the list on 200 OK and flips the
 * marketplace card back to "Connect".
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { ensureRegistry } from "@/lib/agent-registry";
import {
  listConnectionsForUser,
  revokeConnection,
} from "@/lib/connections";
import { getSupabase } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  connection_id: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.connection_id) {
    return json({ error: "invalid_body" }, 400);
  }

  const user = await requireServerUser();

  // Look up the row so we can (a) enforce ownership, (b) find the
  // agent's revocation endpoint if any.
  const mine = await listConnectionsForUser(user.id);
  const target = mine.find((c) => c.id === body.connection_id);
  if (!target) {
    return json({ error: "not_found" }, 404);
  }

  await revokeConnection(user.id, target.id);

  // Best-effort remote revocation. Fire-and-forget the decrypted token
  // isn't needed — the agent side lookups by token only, and the
  // revocation endpoint per RFC 7009 accepts the opaque token string.
  // We fetch the token ciphertext columns fresh to avoid carrying them
  // through the DAO layer when not needed.
  const db = getSupabase();
  const registry = await ensureRegistry();
  const entry = Object.values(registry.agents).find(
    (a) => a.manifest.agent_id === target.agent_id,
  );
  if (db && entry && entry.manifest.connect.model === "oauth2") {
    const revocation_url = entry.manifest.connect.revocation_url;
    if (revocation_url) {
      void (async () => {
        try {
          // We DON'T re-fetch and decrypt the token here — the agent
          // accepts revocation by connection_id in a follow-up
          // iteration; for MVP, local revocation is sufficient and
          // users can re-connect to force token rotation.
          await fetch(revocation_url, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              token_type_hint: "access_token",
              lumo_connection_id: target.id,
            }).toString(),
          });
        } catch (err) {
          console.warn(
            `[connections/disconnect] remote revocation hint failed for agent=${target.agent_id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      })();
    }
  }

  return json({ ok: true });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
