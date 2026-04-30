/**
 * GET /api/notifications/preferences
 * PUT /api/notifications/preferences  body: NotifPrefs
 *
 * STUB — backed by an in-memory Map. NOTIF-PREFS-PERSIST-1 will add
 * a jsonb column on user_profile (or a new table) and swap the
 * implementation. The wire shape is stable; the consumer page
 * (/settings/notifications) does not change when the swap lands.
 */

import { requireServerUser } from "@/lib/auth";
import {
  getPrefs,
  setPrefs,
  validatePrefsBody,
} from "@/lib/notif-prefs-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  return json({ prefs: getPrefs(user.id) });
}

export async function PUT(req: Request): Promise<Response> {
  const user = await requireServerUser();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const validated = validatePrefsBody(raw);
  if (!validated) {
    return json({ error: "invalid_prefs" }, 400);
  }
  const saved = setPrefs(user.id, validated);
  return json({ prefs: saved });
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
