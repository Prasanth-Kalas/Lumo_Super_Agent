// STUB for MOBILE-NOTIF-1; production server replaces with a real
// `device_tokens` table delete keyed by (user_id, device_id).
//
// DELETE → unregister a device. The iOS client calls this on sign-out
// so the server stops attempting push delivery to a device that no
// longer has the user's session.
import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import {
  resolveNotificationsUserId,
  unregisterDevice,
} from "@/lib/notifications-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const userId = await resolveNotificationsUserId(req, getServerUser);
  const { id } = await context.params;
  if (!id) return json({ error: "missing_id" }, 400);
  const ok = unregisterDevice(userId, id);
  if (!ok) return json({ error: "not_found" }, 404);
  return json({ ok: true });
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
