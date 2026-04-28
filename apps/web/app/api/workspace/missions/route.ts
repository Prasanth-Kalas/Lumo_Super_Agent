/**
 * GET /api/workspace/missions — recent missions for the authed user.
 *
 * Backing data for the K10 `MissionCard` component. Each item is a
 * `MissionCardData` shape (mission row + per-step detail) sorted with
 * the most-recently-touched mission first.
 *
 * Auth: matches the pattern in `app/api/workspace/operations/route.ts`
 * — gated by Supabase server session, returns 401 on logged-out, no
 * cross-user reads (the query is filtered by the resolved user_id, not
 * by anything from the URL).
 *
 * Wiring this card into `/workspace` lands in a separate post-D5 commit
 * so the cancel button can call the user-cancel endpoint that D5
 * introduces.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { fetchUserMissions } from "@/lib/workspace-missions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireServerUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limitRaw = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const parsed = parseInt(limitRaw, 10);
    if (Number.isFinite(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
    }
  }

  const missions = await fetchUserMissions(user.id, { limit });
  return NextResponse.json({ missions });
}
