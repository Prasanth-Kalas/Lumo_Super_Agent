/**
 * POST /api/partners/signup — self-serve developer application.
 *
 * Anyone authenticated can submit. The application lands in
 * partner_developers with tier='waitlisted'; an admin promotes it
 * to 'approved' from /admin/review-queue, at which point the
 * developer can submit agents via /publisher.
 *
 * Behavior:
 *   - First-time application: insert row.
 *   - Re-application after rejection: update the existing row back
 *     to 'waitlisted' so the admin can re-evaluate. This avoids
 *     orphan rows when a partner fixes the original concerns and
 *     re-applies.
 *   - Already approved or already waitlisted: no-op (return current
 *     state). We never silently re-set 'approved' → 'waitlisted'.
 *   - Revoked: blocked with a clear message — re-application after
 *     revocation requires admin intervention.
 *
 * Email comes from the authenticated session. The body carries
 * display_name, company, and a free-form reason. None are required
 * (admins can run a row through review with bare email), but we
 * trim and persist whatever's provided.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isPublisher } from "@/lib/publisher/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  display_name?: unknown;
  company?: unknown;
  reason?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const email = (user.email ?? "").toLowerCase();
  if (!email) return json({ error: "missing_email" }, 400);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const display_name = trimOrNull(body.display_name);
  const company = trimOrNull(body.company);
  const reason = trimOrNull(body.reason);

  const sb = getSupabase();
  if (!sb) return json({ error: "db_unavailable" }, 503);

  // Lumo team members on the env allowlist already have publisher
  // access — surface that as an "auto-approved" response so the UI
  // doesn't render the waitlist screen for them. We don't write a
  // row in that case; the env entry remains the source of truth.
  if (isPublisher(email)) {
    return json({
      developer: {
        email,
        display_name,
        company,
        reason,
        tier: "approved" as const,
        source: "env_allowlist",
      },
    });
  }

  // Read current state to decide insert vs. update path.
  const { data: existing, error: readError } = await sb
    .from("partner_developers")
    .select("email, tier")
    .eq("email", email)
    .maybeSingle();
  if (readError) return json({ error: readError.message }, 500);

  if (existing) {
    const tier = (existing as { tier: string }).tier;
    if (tier === "approved" || tier === "waitlisted") {
      // No state change needed; surface current tier.
      return json({
        developer: { email, display_name, company, reason, tier },
      });
    }
    if (tier === "revoked") {
      return json(
        {
          error: "revoked",
          detail:
            "Your developer access was revoked. Contact the Lumo team to re-apply.",
        },
        409,
      );
    }
    // Rejected → re-application path. Reset tier and update fields.
    const { data, error } = await sb
      .from("partner_developers")
      .update({
        display_name,
        company,
        reason,
        tier: "waitlisted",
        reviewer_note: null,
        reviewed_at: null,
        reviewed_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("email", email)
      .select("email, display_name, company, reason, tier")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ developer: data });
  }

  const { data, error } = await sb
    .from("partner_developers")
    .insert({
      email,
      display_name,
      company,
      reason,
      tier: "waitlisted",
    })
    .select("email, display_name, company, reason, tier")
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ developer: data });
}

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
