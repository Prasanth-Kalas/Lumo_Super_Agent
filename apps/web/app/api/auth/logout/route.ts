/**
 * POST /api/auth/logout — end the current Supabase session.
 *
 * Why a POST-only route and not a <Link href="/logout">:
 *   - Sign-out is a state mutation. It should not be triggered by a GET
 *     — prefetchers, preview scrapers, and careless <a> clicks would
 *     otherwise log users out on every hover/preview. POST keeps it
 *     intentional.
 *   - Same-origin POST from a form or fetch() is enough; no CSRF token
 *     needed because Supabase cookies are SameSite=Lax and the target
 *     is destructive-but-idempotent (logging out twice is a no-op).
 *
 * Behavior:
 *   - Calls `supabase.auth.signOut()` — revokes the refresh token
 *     server-side and clears the session cookies via the SSR cookie
 *     adapter baked into getSupabaseServerClient().
 *   - Falls through gracefully if no session is present (idempotent).
 *   - Never throws: if Supabase auth is misconfigured (env unset), we
 *     still return a success response so the client UI can pivot back
 *     to the logged-out state. Security-wise this is strictly safer —
 *     a failed logout MUST NOT leave a user thinking they're signed
 *     out when they aren't; but in the "no auth configured" case there
 *     is no session to leave behind, so returning success is accurate.
 *
 * Response:
 *   204 No Content on success. Client picks the post-logout destination
 *   itself (typically `router.replace("/login")` or a hard `window
 *   .location.assign("/login")` for a full cookie-clean reload).
 */

import { NextResponse } from "next/server";
import { getSupabaseServerClient, isAuthConfigured } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  if (!isAuthConfigured()) {
    // No Supabase = no session to end. Tell the client everything's
    // fine so they can flip their UI to logged-out state.
    return new NextResponse(null, { status: 204 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase.auth.signOut();
    if (error) {
      // Log server-side but still 204 — the client should treat it as
      // logged-out regardless (a stale client thinking it's signed in
      // when the server says signed-out is a worse failure mode than
      // a spurious logout).
      console.warn("[auth/logout] supabase.signOut error:", error.message);
    }
  } catch (e) {
    console.warn("[auth/logout] unexpected error:", e);
  }

  return new NextResponse(null, { status: 204 });
}
