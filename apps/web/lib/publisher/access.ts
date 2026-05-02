/**
 * Identity + access gates.
 *
 * Three roles capture every identity Lumo cares about:
 *
 *   user      regular Lumo end-user (default)
 *   partner   approved developer — may use /publisher
 *   admin     Lumo team — may use /admin
 *
 * Resolution order in `getUserRole(email)`, env wins as a bootstrap:
 *
 *   1. LUMO_ADMIN_EMAILS (env)        → 'admin'
 *   2. profiles.role === 'admin'      → 'admin'
 *   3. LUMO_PUBLISHER_EMAILS (env)    → 'partner'
 *   4. profiles.role === 'partner'    → 'partner'   ← canonical
 *   5. partner_developers.tier ===
 *        'approved' (legacy fallback) → 'partner'
 *   6. otherwise                      → 'user'
 *
 * Migration 067 added profiles.role and a trigger that promotes the
 * matching profile to 'partner' on partner_developers approval. As
 * partners flow through that pipeline, rule 4 covers them and rule 5
 * becomes a safety net for any pre-trigger rows. Admins are
 * elevated by direct UPDATE (env list is the bootstrap).
 *
 * Helpers:
 *
 *   getUserRole(email)         async, returns the resolved role
 *   isApprovedDeveloper(email) async, true when role ∈ {partner, admin}
 *   getDeveloperTier(email)    async, the partner_developers
 *                              application state (separate from role —
 *                              waitlisted/approved/rejected/revoked)
 *   isAdmin(email)             sync, env-only — kept for the routes
 *                              that gate write APIs synchronously
 *   isPublisher(email)         sync, env-only legacy helper
 */
import { getSupabase } from "../db.js";

export type Role = "user" | "partner" | "admin";

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
 * Resolve the canonical role for a user. Order of precedence is
 * spelled out in the file header. Env allowlists win for bootstrap
 * (Lumo team won't always be in the DB before deploy), then DB
 * `profiles.role`, then the legacy `partner_developers.tier`
 * fallback. Returns 'user' on any DB error or absent email.
 */
export async function getUserRole(
  email: string | null | undefined,
): Promise<Role> {
  if (!email) return "user";
  const lower = email.toLowerCase();

  // 1 & 3: env allowlists.
  if (isAdmin(lower)) return "admin";
  const envIsPartner = isPublisher(lower);

  // 2 & 4: profiles.role (canonical).
  const db = getSupabase();
  if (db) {
    const { data, error } = await db
      .from("profiles")
      .select("role")
      .eq("email", lower)
      .maybeSingle();
    if (!error && data) {
      const r = (data as { role?: string }).role;
      if (r === "admin") return "admin";
      if (r === "partner") return "partner";
    }
  }

  if (envIsPartner) return "partner";

  // 5: legacy fallback before the migration's trigger has caught up.
  const tier = await getDeveloperTier(lower);
  if (tier === "approved") return "partner";

  return "user";
}

/**
 * The async access gate publisher routes should use. True for any
 * role that can publish — partner or admin.
 */
export async function isApprovedDeveloper(
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const role = await getUserRole(email);
  return role === "partner" || role === "admin";
}
