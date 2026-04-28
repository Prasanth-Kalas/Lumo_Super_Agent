/**
 * Supabase Auth — server-side helpers for route handlers, server
 * components, and middleware.
 *
 * Why Supabase Auth and not Clerk: we already run Supabase for persistence
 * (trips, events, agent_connections). Adding Clerk means two identity
 * systems to reconcile (Clerk user ids vs. Postgres rows) and paying for
 * what Supabase Auth already gives us. If we outgrow it — fine-grained
 * RBAC, SSO for enterprise, granular MFA — revisit then.
 *
 * The primitives here wrap `@supabase/ssr` which handles the cookie
 * round-trip for us. Every route handler that needs the current user
 * calls `getCurrentUser(req)`; every UI server component calls
 * `getServerUser()`.
 *
 * We intentionally do NOT export the admin/service-role client from
 * here — that lives in lib/db.ts and is keyed per request by the route
 * handler. Keeping user-scoped and admin-scoped clients in different
 * modules makes grep-based security review tractable.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";

// ──────────────────────────────────────────────────────────────────────────
// Env
// ──────────────────────────────────────────────────────────────────────────

function getPublicEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Graceful fallback for public paths. Protected pages/APIs fail
    // closed in middleware when auth env is absent, so a misconfigured
    // production deploy cannot render private surfaces anonymously.
    return null;
  }
  return { url, anonKey };
}

/**
 * Whether Supabase Auth is configured in this environment. Public server
 * components fall through to a null user when false; protected middleware
 * paths return 503 so auth config mistakes are visible and fail closed.
 */
export function isAuthConfigured(): boolean {
  return getPublicEnv() !== null;
}

// ──────────────────────────────────────────────────────────────────────────
// Server Components / Route Handlers — uses next/headers cookies()
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a Supabase client bound to the current request's cookies. Use
 * inside Server Components and Route Handlers. Cookie writes flow back
 * via next/headers cookies().set(), which Next's App Router propagates
 * into the outgoing response.
 */
export function getSupabaseServerClient() {
  const env = getPublicEnv();
  if (!env) {
    throw new AuthError(
      "not_authenticated",
      "[auth] Supabase Auth env is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  const { url, anonKey } = env;
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Called from a Server Component render — setting cookies is
          // disallowed there. Ignore; the middleware will refresh the
          // session before render, so the only thing the server component
          // is doing is reading.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          // See above.
        }
      },
    },
  });
}

/**
 * Resolve the current authenticated user for a server component or route
 * handler. Returns null if no session. Throws ONLY if Supabase's auth
 * server itself errors (network, misconfig) — a missing session is not
 * an error.
 */
export async function getServerUser(): Promise<User | null> {
  if (!isAuthConfigured()) return null;
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    // 401 / AuthSessionMissingError is the common case for logged-out
    // users; that's null, not throw. Other errors are genuine.
    if (
      error.name === "AuthSessionMissingError" ||
      error.message?.toLowerCase().includes("session")
    ) {
      return null;
    }
    console.warn("[auth] getServerUser error:", error.message);
    return null;
  }
  return data.user ?? null;
}

/**
 * Same as getServerUser but throws on logged-out. Use at the top of a
 * route handler that already passed middleware, so logged-out shouldn't
 * happen but if it does we want to 401 loudly.
 */
export async function requireServerUser(): Promise<User> {
  const user = await getServerUser();
  if (!user) {
    throw new AuthError("not_authenticated", "No authenticated user for this request.");
  }
  return user;
}

// ──────────────────────────────────────────────────────────────────────────
// Middleware — uses NextRequest/NextResponse cookies()
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a Supabase client bound to a NextRequest + response. Used by
 * middleware.ts to refresh the session on every request (so route
 * handlers always see a current session).
 *
 * The response is passed in (not created here) so the caller can chain
 * additional headers and return the exact same object we wrote cookies on.
 */
export function getSupabaseMiddlewareClient(
  req: NextRequest,
  res: NextResponse,
) {
  const env = getPublicEnv();
  if (!env) return null;
  const { url, anonKey } = env;
  return createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return req.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        // Supabase SSR expects us to mirror the cookie into both the
        // request (so subsequent reads in the same middleware run see it)
        // and the response (so the browser gets it).
        req.cookies.set({ name, value, ...options });
        res.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        req.cookies.set({ name, value: "", ...options });
        res.cookies.set({ name, value: "", ...options });
      },
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────

export class AuthError extends Error {
  readonly code: "not_authenticated" | "forbidden";
  constructor(code: "not_authenticated" | "forbidden", message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}
