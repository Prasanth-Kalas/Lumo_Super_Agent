/**
 * Email confirmation + PKCE OAuth return handler for Supabase Auth.
 *
 * When a user clicks the confirmation link in their signup email, Supabase
 * redirects them here with `?code=<pkce-code>&next=<where-to-go>`. We
 * exchange the code for a session (this writes the auth cookies) and
 * send them on to `next` (defaults to `/`).
 *
 * Same handler is reused for password-reset links and any future social
 * OAuth flows configured through Supabase.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/auth";

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  if (!code) {
    // Malformed link — bounce to /login with an error marker the form
    // can surface, rather than silently hiding it.
    const loginUrl = url.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?error=missing_code`;
    return NextResponse.redirect(loginUrl);
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const loginUrl = url.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?error=${encodeURIComponent(error.message)}`;
    return NextResponse.redirect(loginUrl);
  }

  // Session cookies are set on the current response by the Supabase SSR
  // adapter. Redirect to `next`.
  const dest = url.clone();
  // `next` is always an absolute path starting with `/`, not a full URL —
  // we enforce that here to prevent open-redirect through a spoofed link.
  dest.pathname = next.startsWith("/") ? next : "/";
  dest.search = "";
  return NextResponse.redirect(dest);
}
