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
 *   2. Gate publisher/admin, memory, ops, MCP, user-data, and the
 *      chat shell at `/` behind an authenticated user. Logged-out
 *      visitors to pages get redirected to /login?next=... . Unauth'd
 *      protected API requests get a 401.
 *
 * Public routes (no gate):
 *
 *   - /login, /signup, /auth/callback, /landing
 *   - /api/health, /api/registry
 *   - /.well-known/*  (reserved)
 *
 * Protected:
 *
 *   - /              — the chat shell. Authed users land on it.
 *                      Unauthed visitors are redirected to
 *                      /login?next=/  (WEB-REDESIGN-1).
 *   - /connections, /memory, /intents, /autonomy, /ops,
 *     /history, /onboarding, /publisher, /admin
 *   - /trips, /receipts, /profile, /settings
 *   - protected /api/* surfaces for user data, publisher/admin, MCP, and ops
 *
 * The matcher at the bottom excludes static assets, images, and Next
 * internal routes so we don't burn a DB round-trip per favicon.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseMiddlewareClient } from "@/lib/auth";

/**
 * Exact-match protected paths. Use this list rather than
 * PROTECTED_PAGE_PREFIXES when you only want to gate one specific
 * pathname — adding a path to the prefix list would (incorrectly)
 * also gate everything beneath it that we don't actually own.
 *
 * "/" is here because the chat shell is now authenticated-only
 * (WEB-REDESIGN-1). Adding "/" to PROTECTED_PAGE_PREFIXES would gate
 * the entire site, which we don't want — the prefix list assumes
 * proper sub-tree ownership.
 */
const PROTECTED_PAGE_EXACT = ["/"];

const PROTECTED_PAGE_PREFIXES = [
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
  // WEB-SCREENS-1 consumer surfaces — every one is per-user and
  // would only render an error state for signed-out visitors.
  "/trips",
  "/receipts",
  "/profile",
  // /settings/* (account, notifications, voice, wake-word, cost) —
  // each sub-route is per-user. Top-level prefix gates the index too.
  "/settings",
];
const PROTECTED_API_PREFIXES = [
  "/api/connections",
  "/api/memory",
  "/api/intents",
  "/api/notifications",
  "/api/autonomy",
  "/api/audio",
  "/api/stt",
  "/api/documents",
  "/api/images",
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
  // WEB-SCREENS-1 read APIs — both scope to user_id internally and
  // would 401 on unauth anyway; gate at the edge so the consumer
  // pages get the same redirect UX as everything else.
  "/api/trips",
  "/api/receipts",
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

  const isProtectedPage =
    PROTECTED_PAGE_EXACT.includes(pathname) ||
    PROTECTED_PAGE_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
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
