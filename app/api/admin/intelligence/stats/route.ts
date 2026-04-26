/**
 * GET /api/admin/intelligence/stats — observability snapshot for the
 * /admin/intelligence dashboard.
 *
 * Auth: same gate as the rest of /admin/* — middleware first, then a
 * defense-in-depth `isAdmin(user.email)` check here. The allowlist
 * comes from LUMO_ADMIN_EMAILS; if it's empty the gate is closed by
 * default (see lib/publisher/access.ts).
 *
 * Read-only. Cron health, brain health, brain tool latency, and the
 * 20 most-recent proactive moments + anomaly findings. The pure
 * shaping lives in lib/admin-stats-core.ts; the DB + brain-fetch glue
 * lives in lib/admin-stats.ts.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { fetchAdminIntelligenceStats } from "@/lib/admin-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const user = await requireServerUser();
  if (!isAdmin(user.email ?? null)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const stats = await fetchAdminIntelligenceStats();
  return NextResponse.json(stats, {
    headers: { "cache-control": "no-store" },
  });
}
