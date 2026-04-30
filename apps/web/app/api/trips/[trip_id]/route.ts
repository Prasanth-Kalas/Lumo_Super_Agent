/**
 * GET /api/trips/[trip_id]
 *
 * Detail read for /trips/[id]. Returns one trip from the user's own
 * history list — scopes to the current user via listTripsForUser
 * rather than getTripById, since TripRecord doesn't carry user_id and
 * we won't leak across users from a per-user history scan. 200-row
 * cap is fine for the consumer page.
 */

import { requireServerUser } from "@/lib/auth";
import { listTripsForUser } from "@/lib/history";
import { findTripForUser } from "@/lib/web-screens-trips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: { trip_id: string } },
): Promise<Response> {
  const user = await requireServerUser();
  const { trip_id } = ctx.params;
  if (!trip_id) {
    return json({ error: "missing_trip_id" }, 400);
  }
  const rows = await listTripsForUser(user.id, 200);
  const found = findTripForUser(rows, trip_id);
  if (!found) {
    return json({ error: "trip_not_found" }, 404);
  }
  return json({ trip: found });
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
