/**
 * GET /api/history
 *
 * Returns the current user's chat + order history. Two collections:
 *
 *   sessions: [{ session_id, started_at, last_activity_at, preview,
 *                user_message_count, trip_ids: [...] }, ...]
 *   trips:    [{ trip_id, session_id, status, payload, created_at,
 *                updated_at, cancel_requested_at }, ...]
 *
 * Query params:
 *   limit_sessions  default 30, max 100
 *   limit_trips     default 50, max 200
 *
 * Auth: resolved from the Supabase session cookie. Falls back to
 * the x-lumo-user-id header when Supabase Auth isn't configured
 * (local dev without envs) so curl-driven dev still works. In prod
 * this always reads the real authed user.
 *
 * Every response is no-store — history is personal, never cache.
 */

import { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { listSessionsForUser, listTripsForUser } from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  // Prefer the authed Supabase user. The middleware also protects
  // this route (see middleware.ts PROTECTED_API_PREFIXES), so when
  // auth is configured we should always land here with a user; the
  // fallback chain is for the dev/unconfigured path only.
  const authed = await getServerUser();
  const user_id =
    authed?.id ?? req.headers.get("x-lumo-user-id") ?? "dev-user";
  const { searchParams } = new URL(req.url);
  const limit_sessions = clampInt(searchParams.get("limit_sessions"), 30, 1, 100);
  const limit_trips = clampInt(searchParams.get("limit_trips"), 50, 1, 200);

  const [sessions, trips] = await Promise.all([
    listSessionsForUser(user_id, limit_sessions),
    listTripsForUser(user_id, limit_trips),
  ]);

  return new Response(JSON.stringify({ sessions, trips }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function clampInt(
  raw: string | null,
  def: number,
  min: number,
  max: number,
): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
