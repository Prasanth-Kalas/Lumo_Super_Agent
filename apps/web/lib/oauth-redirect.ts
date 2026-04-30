/**
 * Pure helper for building the `redirectTo` URL Supabase needs when
 * starting an OAuth flow.
 *
 * Why pull this out: the callsite logic (origin + ?next encode +
 * open-redirect guard) is the kind of thing that's easy to get wrong
 * and easy to assert against. Both /login and /signup use it; a unit
 * test in `web-redesign-oauth.test.mjs` covers the edge cases.
 *
 * Open-redirect guard: `next` must start with `/` (a same-origin
 * absolute path) and must NOT start with `//` (protocol-relative URLs
 * like `//evil.example.com/steal` start with `/` but resolve to
 * cross-origin targets). Anything else falls back to `/`. Supabase
 * preserves the redirectTo query string when it bounces the user back
 * through the provider, so any `?next=` we set here lands on
 * `/auth/callback?code=…&next=…` and the route handler honors it.
 */
export function buildOAuthRedirectTo(origin: string, next: string): string {
  const isSafeNext =
    typeof next === "string" &&
    next.startsWith("/") &&
    !next.startsWith("//");
  const safeNext = isSafeNext ? next : "/";
  // Avoid encoding `?next=/` if the destination is just `/` — keeps the
  // URL short and matches what /auth/callback's default already does.
  if (safeNext === "/") {
    return `${origin}/auth/callback`;
  }
  return `${origin}/auth/callback?next=${encodeURIComponent(safeNext)}`;
}
