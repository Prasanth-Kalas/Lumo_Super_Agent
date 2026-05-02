/**
 * GET /api/partners/me — what's my developer-account state?
 *
 * Drives the /publisher page's render decision: signup form vs.
 * waitlist message vs. full dashboard. Returns the developer row
 * if one exists, plus a `source` discriminator so the UI knows
 * where the access came from (env allowlist always wins and shows
 * as `env_allowlist`).
 *
 * Three success shapes:
 *   - { developer: null }                           → signed in but no
 *                                                     application yet
 *   - { developer: { tier: 'approved', source:
 *       'env_allowlist' } }                         → Lumo-team / hand-
 *                                                     onboarded
 *   - { developer: { tier, ...row, source: 'db' } } → has applied; UI
 *                                                     uses tier to
 *                                                     pick state
 */

import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isPublisher } from "@/lib/publisher/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  const email = (user.email ?? "").toLowerCase();
  if (!email) return json({ developer: null });

  if (isPublisher(email)) {
    return json({
      developer: {
        email,
        display_name: null,
        company: null,
        reason: null,
        tier: "approved" as const,
        source: "env_allowlist" as const,
        reviewer_note: null,
        created_at: null,
      },
    });
  }

  const sb = getSupabase();
  if (!sb) return json({ developer: null });

  const { data, error } = await sb
    .from("partner_developers")
    .select(
      "email, display_name, company, reason, tier, reviewer_note, created_at",
    )
    .eq("email", email)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ developer: null });
  return json({ developer: { ...data, source: "db" as const } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
