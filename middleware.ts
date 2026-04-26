/**
 * Next.js middleware — runs on every matched request before the route
 * handler or server component.
 *
 * Two jobs:
 *
 *   1. Refresh the Supabase Auth session cookie. `@supabase/ssr`'s
 *      getUser() inside the middleware client will silently refresh an
 *      expiring access token and write the new tokens back as cookies.
 *      Without this, a user whose access token lapsed between clicks
 *      would hit a 401 on the next server-side read.
 *
 *   2. Gate app-store, publisher/admin, memory, ops, MCP, and user-data
 *      routes behind an authenticated user. Logged-out visitors to pages
 *      get redirected to /login?next=... . Unauth'd protected API
 *      requests get a 401.
 *
 * Public routes (no gate):
 *
 *   - /            — the landing chat (for now; will be replaced with a
 *                    marketing landing + authed chat behind /chat later).
 *                    We still REFRESH the session here so a transient
 *                    refresh token doesn't go stale.
 *   - /login, /signup, /auth/callback, /landing
 *   - /api/health, /api/registry
 *   - /.well-known/*  (reserved)
 *
 * Protected:
 *
 *   - /marketplace, /connections, /memory, /intents, /autonomy, /ops,
 *     /history, /onboarding, /publisher, /admin
 *   - protected /api/* surfaces for user data, publisher/admin, MCP, and ops
 *
 * The matcher at the bottom excludes static assets, images, and Next
 * internal routes so we don't burn a DB round-trip per favicon.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseMiddlewareClient } from "@/lib/auth";

const PROTECTED_PAGE_PREFIXES = [
  "/marketplace",
  "/connections",
  "/memory",
  "/intents",
  "/autonomy",
  "/ops",
  // /history is the user's personal conversation + order archive —
  // signed-out visitors should be bounced to /login.
  "/history",
  // /onboarding is the post-signup connector flow. Dead-link for a
  // logged-out user; gate it so we don't half-render a page the
  // user can't possibly use.
  "/onboarding",
  // Publisher portal (invited partners only) and admin review queue.
  // Gate checks happen in the routes too — this is defense in depth
  // so the pages don't even render for signed-out users.
  "/publisher",
  "/admin",
];
const PROTECTED_API_PREFIXES = [
  "/api/connections",
  "/api/memory",
  "/api/intents",
  "/api/notifications",
  "/api/autonomy",
  "/api/audio",
  "/api/documents",
  "/api/ops",
  "/api/preferences",
  // Must be gated — listSessionsForUser / listTripsForUser only know
  // about the user_id you pass them; if we let unauth'd requests
  // through we'd leak whichever default the route picks.
  "/api/history",
  // MCP server connections — per-user bearer tokens. Signed-out
  // requests must never reach these handlers.
  "/api/mcp/connections",
  // Publisher APIs. Allowlist check happens inside each route
  // against LUMO_PUBLISHER_EMAILS / LUMO_ADMIN_EMAILS.
  "/api/publisher",
  "/api/admin",
  // App install/remove state. OAuth connection routes are separate.
  "/api/apps",
  // Inline Lumo marketplace installs mutate per-user app grants.
  "/api/lumo/mission/install",
];

/**
 * Carve-outs from the protected API list. These match the prefix in
 * PROTECTED_API_PREFIXES but are intentionally unauthed because they
 * are called by third-party platforms (Meta, etc.) that don't carry
 * a Lumo user session. Each one verifies its own caller via signed
 * payload / shared secret inside the route handler.
 */
const PUBLIC_API_EXCEPTIONS = [
  // Meta data-deletion callback — Meta posts here without auth, route
  // handler verifies HMAC-SHA256 against LUMO_META_APP_SECRET.
  "/api/connections/meta/data-deletion",
];

export async function middleware(req: NextRequest) {
  // Start with a pass-through response. Supabase SSR will attach updated
  // auth cookies to this object as a side effect of getUser().
  const res = NextResponse.next({ request: { headers: req.headers } });

  const { pathname, search } = req.nextUrl;

  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((p) =>
    pathname === p || pathname.startsWith(`${p}/`),
  );
  const isPublicException = PUBLIC_API_EXCEPTIONS.some((p) =>
    pathname === p || pathname.startsWith(`${p}/`),
  );
  const isProtectedApi =
    !isPublicException &&
    PROTECTED_API_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    );

  const supabase = getSupabaseMiddlewareClient(req, res);
  if (!supabase) {
    if (isProtectedApi) {
      return new NextResponse(
        JSON.stringify({ error: "auth_not_configured" }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (isProtectedPage) {
      return new NextResponse("Authentication is not configured.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return res;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (isProtectedPage && !user) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    // Preserve where they were going so /login can send them back.
    loginUrl.searchParams.set("next", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  if (isProtectedApi && !user) {
    return new NextResponse(
      JSON.stringify({ error: "not_authenticated" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }

  return res;
}

export const config = {
  // Run on everything EXCEPT Next internals and static files. The handler
  // above picks what to actually gate.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
