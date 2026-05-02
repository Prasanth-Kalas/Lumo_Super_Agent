/**
 * /api/admin/developers — admin queue for self-serve developer
 * applications.
 *
 *   GET  → list rows from partner_developers, ordered with
 *          waitlisted at the top.
 *   POST → set the tier on one row (approve / reject / revoke /
 *          un-revoke back to waitlisted).
 *
 * Admin-gated via LUMO_ADMIN_EMAILS. The publisher side reads the
 * resulting tier through `isApprovedDeveloper()`.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isAdmin } from "@/lib/publisher/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  const sb = getSupabase();
  if (!sb) return json({ developers: [] });

  // Custom ordering: waitlisted first (admin's actionable queue),
  // then approved (audit), then rejected/revoked (history).
  // Postgres can't sort an enum by custom order without a CASE; do
  // that in JS post-fetch — the table won't grow large enough for
  // the cost to matter.
  const { data, error } = await sb
    .from("partner_developers")
    .select(
      "email, display_name, company, reason, tier, reviewer_note, reviewed_at, reviewed_by, created_at",
    )
    .order("created_at", { ascending: false });
  if (error) return json({ error: error.message }, 500);

  const tierOrder: Record<string, number> = {
    waitlisted: 0,
    approved: 1,
    rejected: 2,
    revoked: 3,
  };
  const sorted = [...(data ?? [])].sort((a, b) => {
    const aOrd = tierOrder[(a as { tier?: string }).tier ?? ""] ?? 9;
    const bOrd = tierOrder[(b as { tier?: string }).tier ?? ""] ?? 9;
    return aOrd - bOrd;
  });

  return json({ developers: sorted });
}

interface PostBody {
  email?: unknown;
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

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const decision = body.decision;
  const note = typeof body.note === "string" ? body.note.trim() : null;

  if (!email) return json({ error: "missing_email" }, 400);
  if (
    decision !== "approved" &&
    decision !== "rejected" &&
    decision !== "revoked" &&
    decision !== "waitlisted"
  ) {
    return json(
      {
        error: "invalid_decision",
        detail:
          "decision must be one of waitlisted | approved | rejected | revoked.",
      },
      400,
    );
  }

  const sb = getSupabase();
  if (!sb) return json({ error: "db_unavailable" }, 503);

  const { data, error } = await sb
    .from("partner_developers")
    .update({
      tier: decision,
      reviewer_note: note,
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.email,
      updated_at: new Date().toISOString(),
    })
    .eq("email", email)
    .select(
      "email, display_name, company, reason, tier, reviewer_note, reviewed_at, reviewed_by, created_at",
    )
    .single();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "developer_not_found" }, 404);
  return json({ developer: data });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
