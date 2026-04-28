/**
 * GET  /api/notifications        → { notifications, unread_count }
 * POST /api/notifications/read   body: { ids?: string[] | "all" }
 *
 * The NotificationBell polls GET every ~60s. Mark-read is POST rather
 * than PATCH so we can accept either a list of ids or the sentinel "all"
 * in one call.
 */

import { requireServerUser } from "@/lib/auth";
import {
  countUnread,
  listForUser,
  markAllRead,
  markRead,
} from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  const [notifications, unread_count] = await Promise.all([
    listForUser(user.id, { limit: 30 }),
    countUnread(user.id),
  ]);
  return json({ notifications, unread_count });
}

export async function POST(req: Request): Promise<Response> {
  const user = await requireServerUser();
  let body: { ids?: string[] | "all" };
  try {
    body = (await req.json()) as { ids?: string[] | "all" };
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (body.ids === "all") {
    const n = await markAllRead(user.id);
    return json({ marked: n });
  }
  if (Array.isArray(body.ids)) {
    await Promise.all(body.ids.map((id) => markRead(user.id, id)));
    return json({ marked: body.ids.length });
  }
  return json({ error: "invalid_body" }, 400);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
