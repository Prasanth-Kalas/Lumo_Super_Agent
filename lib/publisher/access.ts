/**
 * Publisher + admin access gates.
 *
 * Phase 3 only opens the publisher portal to an invited list —
 * vetted partners that the Lumo team has already talked to. This
 * module owns the allowlist checks so every route does the same
 * thing without drift.
 *
 * Two gates:
 *
 *   isPublisher(email)  → may submit agents via /publisher
 *   isAdmin(email)      → may approve/reject via /admin/review-queue
 *
 * Both read from environment variables so the allowlist is
 * deploy-config, not code. Comma-separated, lowercased on read.
 */

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
