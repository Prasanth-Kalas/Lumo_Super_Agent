/**
 * GET /api/me — canonical identity for the current user.
 *
 * Returns:
 *   200 { user: { id, email, full_name, first_name } }  when signed in
 *   401 { reason: "not_authenticated" }                  when signed out
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
 */

import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";

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
  return json({
    user: {
      id: user.id,
      email: user.email ?? null,
      full_name: fullName,
      first_name: firstName,
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
