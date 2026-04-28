/**
 * GET  /api/intents           → list user's standing intents
 * POST /api/intents           body: { description, schedule_cron, timezone?, guardrails?, action_plan?, enabled? }
 */

import { requireServerUser } from "@/lib/auth";
import {
  createIntent,
  listForUser,
  IntentError,
  type StandingIntent,
} from "@/lib/standing-intents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  const intents = await listForUser(user.id);
  return json({ intents });
}

export async function POST(req: Request): Promise<Response> {
  const user = await requireServerUser();
  let body: Partial<StandingIntent>;
  try {
    body = (await req.json()) as Partial<StandingIntent>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof body.description !== "string" || typeof body.schedule_cron !== "string") {
    return json({ error: "invalid_body", detail: "description and schedule_cron required" }, 400);
  }
  try {
    const intent = await createIntent({
      user_id: user.id,
      description: body.description,
      schedule_cron: body.schedule_cron,
      timezone: body.timezone ?? "UTC",
      guardrails: body.guardrails ?? {},
      action_plan: body.action_plan ?? {},
      enabled: body.enabled !== false,
    });
    return json({ intent });
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

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
