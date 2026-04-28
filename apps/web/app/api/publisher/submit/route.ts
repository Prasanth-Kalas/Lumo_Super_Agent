/**
 * POST /api/publisher/submit  — invited partners submit an agent.
 *
 * Body: { manifest_url: string }
 *
 * Validation steps, in order:
 *   1. Caller is an authenticated user on LUMO_PUBLISHER_EMAILS.
 *      Anyone else gets 403 — we don't even hit the URL.
 *   2. The manifest URL is certified: manifest, OpenAPI, health,
 *      permissions, OAuth metadata, and money-tool safety checks.
 *   3. Idempotent upsert into partner_agents. Passing agents go to
 *      pending review; failing agents are saved as certification_failed
 *      so publishers can see the report and resubmit after fixing.
 *
 * Anything that passes 1-4 lands in the review queue. Rejecting at
 * this layer is a gentler UX than letting a bad submission sit in
 * the admin queue — we tell the publisher exactly what broke.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isPublisher } from "@/lib/publisher/access";
import { certifyAgentManifestUrl } from "@/lib/agent-certification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  manifest_url?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isPublisher(user.email)) {
    return json(
      { error: "not_invited", detail: "Your email isn't on the publisher allowlist." },
      403,
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const manifest_url =
    typeof body.manifest_url === "string" ? body.manifest_url.trim() : "";
  if (!manifest_url || !isHttpsUrl(manifest_url)) {
    return json(
      {
        error: "invalid_url",
        detail: "Submit a full HTTPS URL that serves your AgentManifest.",
      },
      400,
    );
  }

  const { report, manifest } = await certifyAgentManifestUrl(manifest_url);

  const sb = getSupabase();
  if (!sb) return json({ error: "db_unavailable" }, 503);

  const nextStatus =
    report.status === "passed" ? "pending" : "certification_failed";

  const { data, error } = await sb
    .from("partner_agents")
    .upsert(
      {
        publisher_email: user.email!.toLowerCase(),
        manifest_url,
        parsed_manifest: manifest,
        certification_status: report.status,
        certification_report: report,
        certified_at: report.checked_at,
        status: nextStatus,
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "publisher_email,manifest_url" },
    )
    .select("id, publisher_email, manifest_url, status, certification_status, certification_report, submitted_at")
    .single();

  if (error) return json({ error: error.message }, 500);

  return json({ submission: data, certification: report });
}

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.protocol === "https:") return true;
    if (u.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
