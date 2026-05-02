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
import { certifyAgentManifestUrl } from "@/lib/agent-certification";

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
      "id, publisher_email, manifest_url, version, is_published, logo_url, parsed_manifest, status, certification_status, certification_report, certified_at, submitted_at, reviewed_at, reviewed_by, reviewer_note",
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
    decision !== "revoked" &&
    decision !== "published" &&
    decision !== "unpublished"
  ) {
    return json(
      {
        error: "invalid_decision",
        detail:
          "decision must be one of approved | rejected | revoked | published | unpublished.",
      },
      400,
    );
  }

  const sb = getSupabase();
  if (!sb) return json({ error: "db_unavailable" }, 503);

  // App Store equivalent of "make this build the current version on
  // the store." Flips is_published=true on this row and false on any
  // other row for the same (publisher_email, manifest_url) pair. The
  // partial unique index `partner_agents_one_published_per_url_idx`
  // is the hard guarantee that this invariant holds even under
  // concurrent admin clicks.
  if (decision === "published") {
    const { data: target, error: readError } = await sb
      .from("partner_agents")
      .select("id, publisher_email, manifest_url, version, status")
      .eq("id", submission_id)
      .single();
    if (readError || !target) {
      return json({ error: readError?.message ?? "submission_not_found" }, 404);
    }
    if ((target as { status?: string }).status !== "approved") {
      return json(
        {
          error: "not_approvable",
          detail: "Only approved versions can be published. Approve first, then publish.",
        },
        409,
      );
    }
    const { publisher_email, manifest_url } = target as {
      publisher_email: string;
      manifest_url: string;
    };
    const unpublishOthers = await sb
      .from("partner_agents")
      .update({ is_published: false })
      .eq("publisher_email", publisher_email)
      .eq("manifest_url", manifest_url)
      .eq("is_published", true)
      .neq("id", submission_id);
    if (unpublishOthers.error) {
      return json({ error: unpublishOthers.error.message }, 500);
    }
    const { data, error } = await sb
      .from("partner_agents")
      .update({
        is_published: true,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.email,
        reviewer_note: note,
      })
      .eq("id", submission_id)
      .select("id, version, is_published, status, reviewed_at, reviewed_by, reviewer_note")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ submission: data });
  }

  if (decision === "unpublished") {
    const { data, error } = await sb
      .from("partner_agents")
      .update({
        is_published: false,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.email,
        reviewer_note: note,
      })
      .eq("id", submission_id)
      .select("id, version, is_published, status, reviewed_at, reviewed_by, reviewer_note")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ submission: data });
  }

  if (decision === "approved") {
    const { data: existing, error: readError } = await sb
      .from("partner_agents")
      .select("id, manifest_url")
      .eq("id", submission_id)
      .single();
    if (readError || !existing) {
      return json({ error: readError?.message ?? "submission_not_found" }, 404);
    }

    const manifestUrl = String((existing as { manifest_url?: string }).manifest_url ?? "");
    const { report, manifest } = await certifyAgentManifestUrl(manifestUrl);
    if (report.status !== "passed" || !manifest) {
      await sb
        .from("partner_agents")
        .update({
          certification_status: report.status,
          certification_report: report,
          certified_at: report.checked_at,
          status: "certification_failed",
          reviewer_note:
            note ??
            "Automated certification failed during approval. Fix the report findings and resubmit.",
        })
        .eq("id", submission_id);
      return json(
        {
          error: "certification_failed",
          detail: "Approval requires a passing certification report.",
          certification: report,
        },
        409,
      );
    }

    const { data, error } = await sb
      .from("partner_agents")
      .update({
        status: "approved",
        parsed_manifest: manifest,
        certification_status: report.status,
        certification_report: report,
        certified_at: report.checked_at,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.email,
        reviewer_note: note,
      })
      .eq("id", submission_id)
      .select("id, status, certification_status, certification_report, reviewed_at, reviewed_by, reviewer_note")
      .single();

    if (error) return json({ error: error.message }, 500);
    return json({ submission: data, certification: report });
  }

  // rejected or revoked. A revoked row was previously live, so flip
  // is_published off — App Store pulling a binary from the store
  // shouldn't leave the binary listed.
  const { data, error } = await sb
    .from("partner_agents")
    .update({
      status: decision,
      is_published: false,
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.email,
      reviewer_note: note,
    })
    .eq("id", submission_id)
    .select("id, status, is_published, reviewed_at, reviewed_by, reviewer_note")
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
