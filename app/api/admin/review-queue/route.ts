/**
 * /api/admin/review-queue — admin inbox for partner submissions.
 *
 *   GET  → list all pending + recently-reviewed submissions.
 *   POST → approve / reject / request-changes a submission.
 *
 * Admin-gated (LUMO_ADMIN_EMAILS). The publisher side surfaces the
 * reviewer_note back to the publisher via /api/publisher/submissions.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isAdmin } from "@/lib/publisher/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  const sb = getSupabase();
  if (!sb) return json({ submissions: [] });

  // Order: pending first, then most-recently-reviewed. A reviewer
  // working down the queue gets a naturally top-weighted list.
  const { data, error } = await sb
    .from("partner_agents")
    .select(
      "id, publisher_email, manifest_url, parsed_manifest, status, submitted_at, reviewed_at, reviewed_by, reviewer_note",
    )
    .order("status", { ascending: true })
    .order("submitted_at", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json({ submissions: data ?? [] });
}

interface PostBody {
  submission_id?: unknown;
  decision?: unknown;
  note?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const submission_id =
    typeof body.submission_id === "string" ? body.submission_id : "";
  const decision = body.decision;
  const note = typeof body.note === "string" ? body.note.trim() : null;

  if (!submission_id) return json({ error: "missing_submission_id" }, 400);
  if (
    decision !== "approved" &&
    decision !== "rejected" &&
    decision !== "revoked"
  ) {
    return json(
      {
        error: "invalid_decision",
        detail: "decision must be one of approved | rejected | revoked.",
      },
      400,
    );
  }

  const sb = getSupabase();
  if (!sb) return json({ error: "db_unavailable" }, 503);

  const { data, error } = await sb
    .from("partner_agents")
    .update({
      status: decision,
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.email,
      reviewer_note: note,
    })
    .eq("id", submission_id)
    .select("id, status, reviewed_at, reviewed_by, reviewer_note")
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ submission: data });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
