/**
 * GET /api/publisher/submissions — list my own submissions.
 *
 * Publisher-scoped. Returns every row the authenticated user has
 * submitted, newest first, with status + reviewer notes. Powers the
 * table on /publisher.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isPublisher } from "@/lib/publisher/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isPublisher(user.email)) {
    return json({ submissions: [] }); // empty, not 403, so page is easier
  }
  const sb = getSupabase();
  if (!sb) return json({ submissions: [] });
  const { data, error } = await sb
    .from("partner_agents")
    .select(
      "id, publisher_email, manifest_url, status, submitted_at, reviewed_at, reviewer_note, publisher_key",
    )
    .eq("publisher_email", user.email!.toLowerCase())
    .order("submitted_at", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json({ submissions: data ?? [] });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
