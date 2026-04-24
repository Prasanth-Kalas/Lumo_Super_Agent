/**
 * GET /api/cron/evaluate-intents
 *
 * Every 15 minutes: find standing intents whose next_fire_at has passed
 * and create a notification for each one. The notification is the
 * "soft" firing — user taps Confirm to dispatch the actual action plan.
 *
 * Auto-dispatch (skipping the user confirmation for high-trust
 * routines) is J6 work — spend caps, per-tool autonomy tiers, kill-
 * switch. Don't shortcut that.
 *
 * After firing, we advance next_fire_at via advanceAfterFire() so the
 * evaluator doesn't re-fire the same tick on its next run.
 */

import type { NextRequest } from "next/server";
import { advanceAfterFire, dueForEvaluation } from "@/lib/standing-intents";
import { deliver } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = req.headers.get("authorization") ?? "";
    if (got !== `Bearer ${expected}`) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  const started = Date.now();
  const due = await dueForEvaluation(200);
  let fired = 0;
  const errors: string[] = [];

  for (const intent of due) {
    try {
      const title = "Lumo is ready to run a routine";
      const body = `"${truncate(intent.description, 160)}" — tap to run or skip this time.`;
      const ok = await deliver({
        user_id: intent.user_id,
        kind: "intent_due",
        title,
        body,
        payload: {
          intent_id: intent.id,
          description: intent.description,
        },
        // Dedup per (intent, fire-time) so back-to-back evaluator runs
        // don't double-deliver if advanceAfterFire failed transiently.
        dedup_key: `intent_due:${intent.id}:${intent.next_fire_at ?? ""}`,
        // Live for 2 hours — if the user doesn't see it by then, the
        // routine was missed.
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });
      if (ok) fired++;
      await advanceAfterFire(intent.id, intent.schedule_cron, intent.timezone);
    } catch (err) {
      errors.push(`${intent.id}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return json({
    ok: errors.length === 0,
    candidates: due.length,
    fired,
    latency_ms: Date.now() - started,
    errors: errors.length ? errors : undefined,
    ran_at: new Date().toISOString(),
  });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
