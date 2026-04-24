/**
 * GET /api/cron/evaluate-intents
 *
 * Every 15 minutes: find standing intents whose next_fire_at has
 * passed. For each, try the J6 autonomy gate — if tier + daily cap +
 * kill-switch all permit, actually dispatch the action plan. Otherwise
 * fall back to the original J3 behavior: drop a notification the user
 * confirms.
 *
 * Action plan shape (stored on standing_intents.action_plan):
 *   {
 *     "tool_sequence": [
 *       { "tool": "food_place_order", "args": {...}, "estimate_cents": 2400 }
 *     ]
 *   }
 * Only the first tool is attempted auto per tick in this MVP — a
 * multi-tool sequence under autonomy is J6.5 work. Missing/empty
 * tool_sequence always falls back to notify.
 *
 * After a fire (auto or notify), advanceAfterFire() moves next_fire_at
 * forward so the same tick isn't re-evaluated.
 */

import type { NextRequest } from "next/server";
import {
  advanceAfterFire,
  dueForEvaluation,
  type StandingIntent,
} from "@/lib/standing-intents";
import { deliver } from "@/lib/notifications";
import {
  evaluateAutonomy,
  recordOutcome,
  toolKindFor,
} from "@/lib/autonomy";
import { dispatchToolCall, type DispatchContext } from "@/lib/router";
import { recordCronRun } from "@/lib/ops";

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
  let autoDispatched = 0;
  let notified = 0;
  const errors: string[] = [];

  for (const intent of due) {
    try {
      const step = firstAutoCandidate(intent);
      if (step) {
        const gate = await evaluateAutonomy({
          user_id: intent.user_id,
          tool_kind: toolKindFor(step.tool),
          tool_name: step.tool,
          amount_cents: step.estimate_cents ?? 0,
          currency: "USD",
          intent_id: intent.id,
        });

        if (gate.allow) {
          // Dispatch. The router enforces PII, confirmation gate
          // (money tools without a summary_hash are already rejected
          // there), and circuit-breaker. Autonomy only gates WHETHER
          // we attempt the call; safety still runs.
          const ctx: DispatchContext = {
            user_id: intent.user_id,
            session_id: `auto:${intent.id}`,
            turn_id: `auto:${intent.id}:${Date.now()}`,
            idempotency_key: `auto:${gate.record_id}`,
            region: "US", // TODO: carry from profile
            device_kind: "web",
            prior_summary: null,
            user_confirmed: false,
            user_pii: {},
          };
          const outcome = await dispatchToolCall(step.tool, step.args, ctx);

          if (outcome.ok) {
            await recordOutcome({
              record_id: gate.record_id,
              outcome: "committed",
              request_ref: extractRef(outcome.result),
            });
            // Deliver a "done" notification so the user knows it fired.
            await deliver({
              user_id: intent.user_id,
              kind: "info",
              title: "Lumo ran your routine",
              body: `"${truncate(intent.description, 160)}" — handled automatically.`,
              payload: {
                intent_id: intent.id,
                autonomous_action_id: gate.record_id,
                tool: step.tool,
              },
              dedup_key: `intent_auto:${intent.id}:${intent.next_fire_at ?? ""}`,
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });
            autoDispatched++;
          } else {
            await recordOutcome({
              record_id: gate.record_id,
              outcome: "failed",
              error_detail: { code: outcome.error.code, message: outcome.error.message },
            });
            // Fall through to the notify-the-user path so they can
            // retry manually if they want.
            await notifyDueFallback(intent, `Auto-run failed: ${outcome.error.code}`);
            notified++;
          }
        } else {
          // Autonomy denied — notify instead. Include the reason so
          // the UI can render a "Autonomy blocked this — tap to run"
          // prompt more precisely later.
          await notifyDueFallback(intent, `Autonomy: ${gate.reason}`);
          notified++;
        }
      } else {
        // No action plan — plain notification (J3 behavior).
        await notifyDueFallback(intent);
        notified++;
      }

      await advanceAfterFire(intent.id, intent.schedule_cron, intent.timezone);
    } catch (err) {
      errors.push(`${intent.id}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ok = errors.length === 0;
  void recordCronRun({
    endpoint: "/api/cron/evaluate-intents",
    started_at: new Date(started),
    ok,
    counts: {
      candidates: due.length,
      auto_dispatched: autoDispatched,
      notified,
    },
    errors,
  });
  return json({
    ok,
    candidates: due.length,
    auto_dispatched: autoDispatched,
    notified,
    latency_ms: Date.now() - started,
    errors: errors.length ? errors : undefined,
    ran_at: new Date().toISOString(),
  });
}

interface ActionStep {
  tool: string;
  args: Record<string, unknown>;
  estimate_cents?: number;
}

/**
 * Pull the first runnable step from an intent's action_plan. Expects
 * shape { tool_sequence: [{ tool, args, estimate_cents? }, ...] }.
 * Returns null if the shape is missing/invalid — caller falls back to
 * notification.
 */
function firstAutoCandidate(intent: StandingIntent): ActionStep | null {
  const plan = intent.action_plan as
    | { tool_sequence?: Array<Record<string, unknown>> }
    | undefined;
  const seq = plan?.tool_sequence;
  if (!Array.isArray(seq) || seq.length === 0) return null;
  const first = seq[0];
  if (!first || typeof first !== "object") return null;
  const tool = typeof first.tool === "string" ? first.tool : null;
  if (!tool) return null;
  const args =
    first.args && typeof first.args === "object"
      ? (first.args as Record<string, unknown>)
      : {};
  const estimate =
    typeof first.estimate_cents === "number" ? first.estimate_cents : undefined;
  return { tool, args, estimate_cents: estimate };
}

async function notifyDueFallback(
  intent: StandingIntent,
  reasonTail?: string,
): Promise<void> {
  const tail = reasonTail ? ` (${reasonTail})` : "";
  await deliver({
    user_id: intent.user_id,
    kind: "intent_due",
    title: "Lumo is ready to run a routine",
    body: `"${truncate(intent.description, 140)}" — tap to run or skip this time.${tail}`,
    payload: {
      intent_id: intent.id,
      description: intent.description,
      reason_tail: reasonTail ?? null,
    },
    dedup_key: `intent_due:${intent.id}:${intent.next_fire_at ?? ""}`,
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000),
  });
}

function extractRef(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  for (const k of ["order_id", "booking_id", "reservation_id", "id"]) {
    const v = r[k];
    if (typeof v === "string") return v;
  }
  return undefined;
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
