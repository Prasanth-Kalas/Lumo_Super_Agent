/**
 * GET /api/trips
 *
 * Thin wrapper around lib/history.listTripsForUser for the consumer
 * /trips list page. Middleware gates this route — see PROTECTED_API_PREFIXES.
 *
 * Response: { trips: TripHistoryRow[] }
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { listTripsForUser } from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const { searchParams } = new URL(req.url);
  const limit = clampInt(searchParams.get("limit"), 50, 1, 200);
  const trips = await listTripsForUser(user.id, limit);
  return new Response(JSON.stringify({ trips }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
