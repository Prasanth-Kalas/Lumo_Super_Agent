/**
 * GET   /api/memory/profile   → { profile: UserProfile | null }
 * PATCH /api/memory/profile   body: partial UserProfile
 *
 * GET reads the current row. /settings/account and /profile both read
 * through this; cheap enough to hit per page render.
 *
 * PATCH edits the structured profile row. Pass only the fields you want
 * to change; omitted leaves existing value, explicit null clears.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { getProfile, upsertProfile } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  const profile = await getProfile(user.id);
  return json({ profile });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  let patch: Record<string, unknown>;
  try {
    patch = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const updated = await upsertProfile(user.id, patch as Parameters<typeof upsertProfile>[1]);
  return json({ profile: updated });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
