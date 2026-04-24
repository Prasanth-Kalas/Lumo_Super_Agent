/**
 * GET /api/admin/escalations
 *
 * List open escalations, oldest first. Support ops uses this to work
 * the backlog of trips that need human refund follow-up because
 * Saga compensation failed.
 *
 * Auth: stubbed — gated by a shared secret header for now. Wire to
 * Clerk's admin role check when the auth PR lands. A missing or
 * wrong `x-lumo-admin-token` returns 401 without leaking whether
 * the token existed.
 *
 * Query params:
 *   user_id  — filter to a specific user (for "what's open for X?")
 *   limit    — default 100, max 500
 *
 * Response body:
 *   { escalations: EscalationRow[] }
 *
 * Empty list is a valid response (no open escalations).
 */

import { NextRequest } from "next/server";
import { listOpenEscalations } from "@/lib/escalations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const expected = process.env.LUMO_ADMIN_TOKEN;
  const provided = req.headers.get("x-lumo-admin-token");

  if (!expected) {
    // If the operator hasn't set the token, we refuse to expose the
    // endpoint — don't leak escalation data even on misconfiguration.
    return json(503, {
      error: "admin_disabled",
      message: "LUMO_ADMIN_TOKEN env is not configured.",
    });
  }
  if (provided !== expected) {
    return json(401, { error: "unauthorized" });
  }

  const { searchParams } = new URL(req.url);
  const user_id = searchParams.get("user_id") ?? undefined;
  const rawLimit = Number(searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(500, Math.floor(rawLimit)))
    : 100;

  const escalations = await listOpenEscalations({ user_id, limit });
  return json(200, { escalations, count: escalations.length });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
