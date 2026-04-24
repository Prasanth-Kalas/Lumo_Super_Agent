/**
 * GET   /api/autonomy            → current autonomy config + today's spend + recent actions
 * PATCH /api/autonomy            body: { tiers?, daily_cap_cents?, kill_switch_until? | 'clear' }
 */

import { requireServerUser } from "@/lib/auth";
import {
  getAutonomy,
  getTodaySpendCents,
  listRecentActions,
  updateAutonomy,
  KNOWN_TOOL_KINDS,
  isValidTier,
} from "@/lib/autonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  const [autonomy, spend_today_cents, recent_actions] = await Promise.all([
    getAutonomy(user.id),
    getTodaySpendCents(user.id),
    listRecentActions(user.id, 30),
  ]);
  return json({
    autonomy,
    spend_today_cents,
    recent_actions,
    known_tool_kinds: KNOWN_TOOL_KINDS,
  });
}

export async function PATCH(req: Request): Promise<Response> {
  const user = await requireServerUser();
  let body: {
    tiers?: Record<string, string>;
    daily_cap_cents?: number;
    kill_switch_until?: string | null | "24h";
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (body.tiers) {
    for (const [k, v] of Object.entries(body.tiers)) {
      if (!isValidTier(v)) {
        return json(
          { error: "invalid_tier", detail: `${k}=${v}` },
          400,
        );
      }
    }
  }
  // Convenience: "24h" sets the panic kill-switch to 24h from now.
  let kill_switch_until: string | null | undefined;
  if (body.kill_switch_until === "24h") {
    kill_switch_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  } else {
    kill_switch_until = body.kill_switch_until;
  }
  try {
    const updated = await updateAutonomy(user.id, {
      tiers: body.tiers,
      daily_cap_cents: body.daily_cap_cents,
      kill_switch_until,
    });
    return json({ autonomy: updated });
  } catch (err) {
    return json(
      { error: "update_failed", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
