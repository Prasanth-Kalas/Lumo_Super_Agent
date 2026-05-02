/**
 * GET /api/me — canonical identity for the current user.
 *
 * Returns:
 *   200 { user: { id, email, full_name, first_name, member_since,
 *                  role } }                                          when signed in
 *   401 { reason: "not_authenticated" }                              when signed out
 *
 * Why this exists: the shell (chat page, header, /memory page) needs
 * to show "Hey Alex" and "signed in as alex@..." without every page
 * re-plumbing Supabase Auth. One cheap GET answers that question
 * consistently.
 *
 * `first_name` is derived server-side from `full_name` (first
 * whitespace-split token) so the client doesn't have to duplicate
 * parsing. If no full_name is set, first_name is null and callers
 * should fall back to email-local-part or a generic greeting.
 *
 * `member_since` mirrors Supabase's `user.created_at`. /settings/account
 * shows it under the email; consumer surfaces should prefer this over
 * re-deriving from anywhere else.
 *
 * `role` is the resolved identity role — 'user' (default), 'partner'
 * (approved publisher), or 'admin' (Lumo team). The shell uses it to
 * gate menu items (e.g. show "Developer" link only for partners,
 * "Admin" link only for admins). See lib/publisher/access.ts for the
 * resolution order.
 */

import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { getUserRole } from "@/lib/publisher/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await getServerUser();
  if (!user) {
    return json({ reason: "not_authenticated" }, 401);
  }
  const fullName =
    (user.user_metadata as { full_name?: string } | null)?.full_name ?? null;
  const firstName = deriveFirstName(fullName);
  const role = await getUserRole(user.email ?? null);
  return json({
    user: {
      id: user.id,
      email: user.email ?? null,
      full_name: fullName,
      first_name: firstName,
      member_since: user.created_at ?? null,
      role,
    },
  });
}

function deriveFirstName(full: string | null): string | null {
  if (!full) return null;
  const trimmed = full.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
