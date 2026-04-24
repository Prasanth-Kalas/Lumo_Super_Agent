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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const connections = await listConnectionsForUser(user.id);
  return json({ connections });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
