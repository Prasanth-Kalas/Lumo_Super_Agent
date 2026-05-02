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
import { isApprovedDeveloper } from "@/lib/publisher/access";
import { certifyAgentManifestUrl } from "@/lib/agent-certification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  manifest_url?: unknown;
  /**
   * Optional logo URL for the agent's marketplace card. Must be
   * https (or http for local dev). When omitted, the row's
   * existing logo_url is preserved on resubmit; on first submit
   * this defaults to whatever the manifest may declare in
   * `logo_url` (forward-compat — manifest schema doesn't require
   * it today).
   */
  logo_url?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!(await isApprovedDeveloper(user.email))) {
    return json(
      {
        error: "not_invited",
        detail:
          "Your developer application isn't approved yet. Visit /publisher to check status or apply.",
      },
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

  // App Store framing: each (publisher_email, manifest_url, version)
  // is a separate, immutable submission. The certifier always parses
  // a manifest with a required semver `version`, so for a passing
  // submission we always have one. Failing submissions may not have
  // a parseable manifest — store the legacy sentinel so the row
  // still lands and the publisher can see the failure report.
  const submitted_version =
    (manifest && typeof manifest.version === "string" && manifest.version) ||
    "0.0.0-unparsed";

  // Logo URL. Prefer the explicit body override, fall back to a
  // manifest-declared logo_url (forward-compat — the SDK schema
  // can add it without a route change). Bare validation: must be
  // http(s); the DB CHECK constraint enforces the same shape.
  const logo_url = pickLogoUrl(body.logo_url, manifest);

  const upsertRow: Record<string, unknown> = {
    publisher_email: user.email!.toLowerCase(),
    manifest_url,
    version: submitted_version,
    parsed_manifest: manifest,
    certification_status: report.status,
    certification_report: report,
    certified_at: report.checked_at,
    status: nextStatus,
    submitted_at: new Date().toISOString(),
    // is_published is intentionally NOT set here. Even on a
    // passing first submission, the row stays unpublished until
    // an admin promotes it from /admin/review-queue. The App Store
    // equivalent: passing review ≠ live on the store — the
    // publisher (or in our v1, the Lumo admin) decides when to
    // flip the switch.
  };
  // Only include logo_url in the payload when we have one, so a
  // bare /api/publisher/submit (no body.logo_url, no manifest
  // declaration) doesn't accidentally clear an existing logo on
  // a re-submit of the same version.
  if (logo_url !== undefined) upsertRow.logo_url = logo_url;

  const { data, error } = await sb
    .from("partner_agents")
    .upsert(upsertRow, { onConflict: "publisher_email,manifest_url,version" })
    .select("id, publisher_email, manifest_url, version, is_published, logo_url, status, certification_status, certification_report, submitted_at")
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

/**
 * Resolve the logo_url to write on this submit. Returns:
 *   - undefined → no source available (don't touch DB column)
 *   - null      → caller passed an empty string to clear the logo
 *   - string    → a validated http(s) URL
 *
 * Body wins over manifest. Body string trimmed; if empty after
 * trim, treats as an explicit clear. The manifest is typed as
 * `unknown` because the SDK schema doesn't formally declare a
 * logo_url field yet — we'll read it forward-compat style.
 */
function pickLogoUrl(
  bodyValue: unknown,
  manifest: unknown,
): string | null | undefined {
  if (typeof bodyValue === "string") {
    const trimmed = bodyValue.trim();
    if (!trimmed) return null;
    return isHttpsUrl(trimmed) ? trimmed : undefined;
  }
  const manifestLogo =
    manifest && typeof manifest === "object" && manifest !== null
      ? (manifest as { logo_url?: unknown }).logo_url
      : undefined;
  const fromManifest =
    typeof manifestLogo === "string" ? manifestLogo.trim() : "";
  if (fromManifest && isHttpsUrl(fromManifest)) return fromManifest;
  return undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
