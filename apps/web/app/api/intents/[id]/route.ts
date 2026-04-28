/**
 * PATCH  /api/intents/[id]   body: partial { description, schedule_cron, timezone, guardrails, action_plan, enabled }
 * DELETE /api/intents/[id]
 */

import { requireServerUser } from "@/lib/auth";
import { deleteIntent, updateIntent, IntentError } from "@/lib/standing-intents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  ctx: { params: { id: string } },
): Promise<Response> {
  const user = await requireServerUser();
  const id = ctx.params.id;
  let patch: Record<string, unknown>;
  try {
    patch = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  try {
    const updated = await updateIntent({
      user_id: user.id,
      id,
      patch: patch as Parameters<typeof updateIntent>[0]["patch"],
    });
    if (!updated) return json({ error: "not_found" }, 404);
    return json({ intent: updated });
  } catch (err) {
    if (err instanceof IntentError) {
      return json({ error: err.code, detail: err.message }, 400);
    }
    return json(
      { error: "internal_error", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: { id: string } },
): Promise<Response> {
  const user = await requireServerUser();
  const id = ctx.params.id;
  try {
    await deleteIntent(user.id, id);
    return json({ ok: true });
  } catch (err) {
    return json(
      { error: "internal_error", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
