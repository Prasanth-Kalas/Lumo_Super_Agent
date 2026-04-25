/**
 * GET /api/cron/proactive-scan
 *
 * Scheduled by vercel.json. Runs every 15 minutes. Scans for anomalies
 * and drops notifications in the outbox. Dedup is enforced by the
 * partial unique index on notifications.dedup_key, so re-running the
 * scan while a notification is still live is a no-op.
 *
 * Rules in this MVP:
 *
 *   R1. Trip stuck — trips.status='dispatching' AND updated_at > 5 min ago.
 *       Something's wedged. Tell the user, offer the cancel path.
 *       dedup_key = `trip_stuck:<trip_id>`. Expires when the trip
 *       finalizes (scan recomputes on the next tick).
 *
 *   R2. Trip rolled back — trips.status='rolled_back' AND updated_at in
 *       the last hour AND no existing live alert. Saga fired; user
 *       should know.
 *       dedup_key = `trip_rolled_back:<trip_id>`.
 *
 *   R3. Token expiring — agent_connections.status='active' AND expires_at
 *       is within 24h. Gentle heads-up to reconnect before it breaks.
 *       dedup_key = `token_expiring:<connection_id>`. Expires at the
 *       actual token expiry so if they refresh we don't keep nagging.
 *
 * Auth: requires CRON_SECRET (Vercel sets this in the environment and
 * includes it on scheduled invocations via the Authorization header).
 * Un-authed invocations get 401 — cheap defense against drive-by scans
 * on a public deployment.
 */

import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/db";
import { deliver } from "@/lib/notifications";
import { recordCronRun } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel caps hobby at 60s; we rarely need >5s.

export async function GET(req: NextRequest): Promise<Response> {
  // Vercel's cron scheduler attaches `Authorization: Bearer <CRON_SECRET>`.
  // A curl from the internet has neither — 401 out.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return json({ error: "cron_secret_missing" }, 503);
  }
  const got = req.headers.get("authorization") ?? "";
  if (got !== `Bearer ${expected}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const db = getSupabase();
  if (!db) {
    return json({ ok: false, reason: "persistence_disabled" }, 200);
  }

  const started = Date.now();
  let r1 = 0;
  let r2 = 0;
  let r3 = 0;
  const errors: string[] = [];

  // ── R1: trip stuck ───────────────────────────────────────────────
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("trips")
      .select("trip_id, user_id, updated_at, payload")
      .eq("status", "dispatching")
      .lt("updated_at", fiveMinAgo)
      .limit(200);
    if (error) throw error;
    for (const row of data ?? []) {
      const title = "A trip is taking longer than expected";
      const body =
        "Lumo started booking your trip but hasn't finished. Tap to cancel or retry.";
      const n = await deliver({
        user_id: String((row as { user_id?: string }).user_id),
        kind: "trip_stuck",
        title,
        body,
        payload: { trip_id: (row as { trip_id?: string }).trip_id },
        dedup_key: `trip_stuck:${(row as { trip_id?: string }).trip_id}`,
        // Expires in 6 hours — by then it's either done or a support issue.
        expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000),
      });
      if (n) r1++;
    }
  } catch (err) {
    errors.push(`R1:${err instanceof Error ? err.message : String(err)}`);
  }

  // ── R2: trip rolled back recently ────────────────────────────────
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("trips")
      .select("trip_id, user_id, updated_at, payload")
      .eq("status", "rolled_back")
      .gt("updated_at", oneHourAgo)
      .limit(200);
    if (error) throw error;
    for (const row of data ?? []) {
      const title = "Your trip was rolled back";
      const body =
        "One leg failed so Lumo undid the rest automatically. No charges held.";
      const n = await deliver({
        user_id: String((row as { user_id?: string }).user_id),
        kind: "trip_rolled_back",
        title,
        body,
        payload: { trip_id: (row as { trip_id?: string }).trip_id },
        dedup_key: `trip_rolled_back:${(row as { trip_id?: string }).trip_id}`,
        // These are informational; keep live for 3 days or until read.
        expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      });
      if (n) r2++;
    }
  } catch (err) {
    errors.push(`R2:${err instanceof Error ? err.message : String(err)}`);
  }

  // ── R3: agent token expiring within 24h ──────────────────────────
  try {
    const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("agent_connections")
      .select("id, user_id, agent_id, expires_at")
      .eq("status", "active")
      .not("expires_at", "is", null)
      .lt("expires_at", in24h)
      .gt("expires_at", new Date().toISOString())
      .limit(500);
    if (error) throw error;
    for (const row of data ?? []) {
      const id = String((row as { id?: string }).id);
      const agent_id = String((row as { agent_id?: string }).agent_id);
      const user_id = String((row as { user_id?: string }).user_id);
      const exp = (row as { expires_at?: string }).expires_at;
      const n = await deliver({
        user_id,
        kind: "token_expiring",
        title: `Reconnect ${agent_id} soon`,
        body: `Your connection to ${agent_id} expires within a day. Reconnect to keep using it.`,
        payload: { connection_id: id, agent_id },
        dedup_key: `token_expiring:${id}`,
        // Expires exactly when the token does — if they reconnect before
        // then, the re-scan won't re-fire because agent_connections.
        // expires_at moves forward.
        expires_at: exp ? new Date(exp) : null,
      });
      if (n) r3++;
    }
  } catch (err) {
    errors.push(`R3:${err instanceof Error ? err.message : String(err)}`);
  }

  const ok = errors.length === 0;
  // Fire-and-forget — observability must never flip a successful
  // cron run into a failed one if the insert errors.
  void recordCronRun({
    endpoint: "/api/cron/proactive-scan",
    started_at: new Date(started),
    ok,
    counts: { trip_stuck: r1, trip_rolled_back: r2, token_expiring: r3 },
    errors,
  });
  return json({
    ok,
    delivered: { trip_stuck: r1, trip_rolled_back: r2, token_expiring: r3 },
    latency_ms: Date.now() - started,
    errors: errors.length ? errors : undefined,
    ran_at: new Date().toISOString(),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
