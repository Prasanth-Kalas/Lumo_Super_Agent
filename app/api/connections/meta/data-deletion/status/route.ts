/**
 * /api/connections/meta/data-deletion/status — confirmation lookup.
 *
 * Meta's data-deletion spec lets users (or Meta itself) check the status
 * of a deletion request via a status URL we returned from the callback.
 * We respond with a tiny JSON body describing the request lifecycle.
 *
 * Public endpoint — no auth required, but tickets are random UUIDs so
 * they're effectively unguessable.
 */

import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)) {
    return NextResponse.json(
      { error: "invalid or missing code" },
      { status: 400 },
    );
  }

  // We don't currently track per-ticket fine-grained status because
  // deletion is synchronous in the callback handler — the moment the
  // ticket is minted, the data is already gone. Future: add a
  // deletion_tickets table if we ever move to async processing.
  return NextResponse.json({
    code,
    status: "completed",
    note:
      "All Lumo-side data tied to your Meta account has been deleted. " +
      "Cached responses, sub-account list, and connection tokens removed. " +
      "Audit log entries (linked write actions you authorized) are retained " +
      "in anonymized form for 90 days per our privacy policy.",
    contact: "privacy@lumotechnologies.com",
  });
}
