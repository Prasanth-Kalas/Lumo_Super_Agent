/**
 * GET /api/memory
 *
 * Returns everything the Super Agent has learned about the authed user:
 *   - profile: structured row (user_profile)
 *   - facts:   live free-text memories (user_facts where deleted_at is null)
 *   - patterns: high-confidence aggregations (user_behavior_patterns)
 *
 * Powers the /memory page. Gated by middleware.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import {
  getProfile,
  listFacts,
  listHighConfidencePatterns,
} from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const [profile, facts, patterns] = await Promise.all([
    getProfile(user.id),
    listFacts(user.id, { limit: 500 }),
    listHighConfidencePatterns(user.id, 0, 50),
  ]);
  return new Response(
    JSON.stringify({ profile, facts, patterns }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
