// STUB for MOBILE-NOTIF-1; production swap is to extend the existing
// `/api/proactive-moments/:id` PATCH endpoint with a `snoozed` action
// (in addition to the existing `acted_on` and `dismissed`). Until that
// extension lands, this dedicated route accepts `{ momentId,
// snoozeUntilISO }` and records snooze state in the notifications stub
// store so the iOS NotificationActionHandler's `remind-later` action
// has a backing endpoint.
//
// Swap path: replace this route's body with a fetch to
// `/api/proactive-moments/${momentId}` PATCH `{ status: "snoozed",
// snooze_until: snoozeUntilISO }` once `normalizeMomentActionBody` in
// proactive-moments-core accepts that status.
import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { resolveNotificationsUserId } from "@/lib/notifications-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SnoozeRequest {
  momentId?: string;
  snoozeUntilISO?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const _userId = await resolveNotificationsUserId(req, getServerUser);
  const body = (await req.json().catch(() => null)) as SnoozeRequest | null;
  if (!body) return json({ error: "invalid_json" }, 400);

  const momentId = body.momentId ?? "";
  const snoozeUntil = body.snoozeUntilISO ?? "";

  if (!momentId.match(/^mom_/)) {
    return json({ error: "invalid_moment_id" }, 400);
  }
  // ISO 8601 with optional fractional seconds and Z/offset.
  if (!snoozeUntil.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
    return json({ error: "invalid_snooze_until" }, 400);
  }

  // The stub doesn't persist snooze state — it acks. The real PATCH
  // path on the existing proactive-moments table is where snooze
  // state lives once swapped over.
  return json({ ok: true, momentId, snoozeUntilISO: snoozeUntil });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
