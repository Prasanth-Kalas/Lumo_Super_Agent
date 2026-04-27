import type { NextRequest } from "next/server";
import { requireServerUser, AuthError } from "@/lib/auth";
import { recordPreferenceEvents } from "@/lib/preference-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  let user_id: string;
  try {
    const user = await requireServerUser();
    user_id = user.id;
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: err.code }, err.code === "not_authenticated" ? 401 : 403);
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  try {
    const result = await recordPreferenceEvents(user_id, body);
    // Preference logging is optional telemetry. If Supabase is degraded,
    // preserve app UX and expose the persistence result in-band instead of
    // letting a 500 cascade into client retry storms.
    return json(
      {
        ...result,
        ok: true,
        persisted: result.ok && !result.error && result.inserted > 0,
      },
      200,
    );
  } catch (err) {
    console.warn("[preferences/events] telemetry write failed:", err);
    return json(
      {
        ok: true,
        persisted: false,
        inserted: 0,
        skipped: 0,
        error: "telemetry_unavailable",
      },
      200,
    );
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
