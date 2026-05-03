/**
 * /publisher — redirected.
 *
 * Earlier this file hosted a self-serve developer portal built on
 * partner_developers + partner_agents (PRs claude-code/marketplace-
 * developer-portal-1, marketplace-roles-and-tiers-1). It has been
 * superseded by the richer /developer/* surface that's wired into
 * the canonical marketplace runtime (marketplace_agents,
 * developer_*, trust/*). Keep the redirect so any link or bookmark
 * still works.
 */

import { redirect } from "next/navigation";

export default function PublisherRedirect(): never {
  redirect("/developer");
}
