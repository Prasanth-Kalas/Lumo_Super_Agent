/**
 * Supabase client singleton + graceful fallback.
 *
 * Rationale: we want the Super Agent to boot and run tests without a
 * live Supabase project (local dev, CI, demo sandboxes). When
 * `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing we return
 * `null` and let callers fall back to in-memory state. The tradeoff is
 * explicit: no durable audit log in that mode — acceptable for dev,
 * never acceptable for prod, so the logger warns once on startup.
 *
 * Why service-role and not anon: we only talk to Supabase from Node
 * route handlers and the orchestrator. No browser reads these tables.
 * Service-role bypasses RLS which is what we want server-side; RLS can
 * be layered on later if a client path is introduced.
 *
 * Why re-use the same instance: the Supabase JS client keeps an
 * internal fetch agent + auth refresher. Instantiating per-request
 * leaks sockets on Node 20 and is measurably slower.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;
let warned = false;

export function getSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    if (!warned) {
      warned = true;
      console.warn(
        "[db] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — " +
          "running with in-memory state only. Audit log and replay " +
          "are disabled. Set both env vars to enable persistence.",
      );
    }
    cached = null;
    return cached;
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Server-side use — pooled fetch is fine.
    global: { headers: { "x-lumo-service": "super-agent" } },
  });
  return cached;
}

export function isPersistenceEnabled(): boolean {
  return getSupabase() !== null;
}

/**
 * Test hook — wipe the cached client so a test that mocks env vars can
 * reboot the client. Not exported from any public path.
 */
export function __resetDbForTesting(): void {
  cached = undefined;
  warned = false;
}
