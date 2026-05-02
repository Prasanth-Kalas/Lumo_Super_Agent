/**
 * Publisher + admin access gates.
 *
 * Two paths can grant publisher access:
 *
 *   1. LUMO_PUBLISHER_EMAILS env (sync) — for Lumo's own team and
 *      hand-onboarded design partners. Always wins.
 *   2. partner_developers table (async) — self-serve signups.
 *      A row with tier='approved' here counts the same as an env
 *      entry. Migration 064 added this surface.
 *
 * Routes that need to gate access call `isApprovedDeveloper(email)`
 * (async) so the DB-backed tier is honored. The legacy sync
 * `isPublisher(email)` is kept for code paths that genuinely cannot
 * await — but every route in this codebase should use the async one
 * now that self-serve is live.
 *
 *   isApprovedDeveloper(email) → may submit agents via /publisher
 *   getDeveloperTier(email)    → null | 'waitlisted' | 'approved'
 *                                 | 'rejected' | 'revoked' (the DB
 *                                 row's tier; null means no row)
 *   isAdmin(email)             → may approve/reject via /admin
 *
 * Admin gating stays env-only — admin is a Lumo-team-only role,
 * never self-serve.
 */
import { getSupabase } from "../db.js";

export type DeveloperTier =
  | "waitlisted"
  | "approved"
  | "rejected"
  | "revoked";

function parseEmailList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * LUMO_PUBLISHER_EMAILS — comma-separated emails invited to the
 * publisher portal. Leaving it unset means "publisher portal is
 * disabled for now": /publisher renders a holding page.
 */
export function publisherAllowlist(): Set<string> {
  return parseEmailList(process.env.LUMO_PUBLISHER_EMAILS);
}

/**
 * LUMO_ADMIN_EMAILS — comma-separated emails that can approve
 * submissions. Should be a strict subset of Lumo team emails.
 */
export function adminAllowlist(): Set<string> {
  return parseEmailList(process.env.LUMO_ADMIN_EMAILS);
}

export function isPublisher(email: string | null | undefined): boolean {
  if (!email) return false;
  return publisherAllowlist().has(email.toLowerCase());
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminAllowlist().has(email.toLowerCase());
}

/**
 * Read the partner_developers row for an email, returning the tier
 * or null if no row exists. Lowercases the email to match the PK.
 * Returns null on any DB error so callers can fail closed by ORing
 * with the env allowlist.
 */
export async function getDeveloperTier(
  email: string | null | undefined,
): Promise<DeveloperTier | null> {
  if (!email) return null;
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("partner_developers")
    .select("tier")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (error) {
    console.warn("[access] developer tier read failed:", error.message);
    return null;
  }
  const t = (data as { tier?: string } | null)?.tier;
  if (
    t === "waitlisted" ||
    t === "approved" ||
    t === "rejected" ||
    t === "revoked"
  ) {
    return t;
  }
  return null;
}

/**
 * The async access gate routes should use. True if the email is on
 * the env allowlist OR has an approved partner_developers row.
 * Anything else (waitlisted, rejected, revoked, no row) → false.
 */
export async function isApprovedDeveloper(
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  if (isPublisher(email)) return true;
  const tier = await getDeveloperTier(email);
  return tier === "approved";
}
