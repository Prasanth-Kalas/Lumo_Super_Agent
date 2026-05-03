/**
 * Identity + access gates.
 *
 * Three roles capture every identity Lumo cares about:
 *
 *   user       regular Lumo end-user (default)
 *   developer  approved developer — may use /developer/*
 *   admin      Lumo team — may use /admin
 *
 * Resolution order in `getUserRole(email)`, env wins as a bootstrap:
 *
 *   1. LUMO_ADMIN_EMAILS (env)        → 'admin'
 *   2. profiles.role === 'admin'      → 'admin'
 *   3. LUMO_PUBLISHER_EMAILS (env)    → 'developer'
 *   4. profiles.role === 'developer'  → 'developer'  ← canonical
 *   5. otherwise                      → 'user'
 *
 * Approval flows through the /developer/* portal (developer_identity_
 * verifications, developer_promotion_requests). When the trust
 * pipeline marks a developer approved, that surface owns setting
 * profiles.role; rule 4 then covers them. Env allowlists remain the
 * bootstrap for the Lumo team.
 *
 * The legacy LUMO_PUBLISHER_EMAILS naming is kept because it's
 * already deployed in env config; it grants the 'developer' role
 * regardless of the variable name.
 */
import { getSupabase } from "../db.js";

export type Role = "user" | "developer" | "admin";

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
 * LUMO_PUBLISHER_EMAILS — comma-separated emails granted the
 * 'developer' role at request time without a profiles.role write.
 * Used for the Lumo team and hand-onboarded design partners.
 */
export function publisherAllowlist(): Set<string> {
  return parseEmailList(process.env.LUMO_PUBLISHER_EMAILS);
}

/**
 * LUMO_ADMIN_EMAILS — comma-separated emails granted the 'admin'
 * role. Should be a strict subset of Lumo team emails.
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
 * Resolve the canonical role for a user. Env allowlists win for
 * bootstrap (Lumo team won't always be in the DB before deploy),
 * then DB `profiles.role`. Returns 'user' on any DB error or
 * absent email.
 */
export async function getUserRole(
  email: string | null | undefined,
): Promise<Role> {
  if (!email) return "user";
  const lower = email.toLowerCase();

  if (isAdmin(lower)) return "admin";
  const envIsDeveloper = isPublisher(lower);

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
      if (r === "developer") return "developer";
    }
  }

  if (envIsDeveloper) return "developer";

  return "user";
}

/**
 * Convenience for routes that need to gate publisher-side actions.
 * True for any role that can publish — developer or admin.
 */
export async function isApprovedDeveloper(
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const role = await getUserRole(email);
  return role === "developer" || role === "admin";
}
