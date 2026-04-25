/**
 * /api/cron/publish-due-posts — every minute, surface scheduled posts
 * whose `scheduled_for <= now()` to the user's notification queue.
 *
 * IMPORTANT: this cron does NOT auto-publish. Per the locked autonomy
 * decision in docs/specs/workspace-and-creator-connectors.md §8, every
 * post / reply / DM passes through the confirmation card regardless
 * of autonomy tier. The cron's job is:
 *
 *   1. Find scheduled_posts where status='queued' AND scheduled_for<=now()
 *   2. Move them to status='pending' and create a pending_user_actions row
 *   3. Fire a notification ('your scheduled YouTube reply is ready')
 *   4. The user taps the notification → sees the confirmation card →
 *      confirms or cancels → publish (or not) happens then
 *   5. Sweep: any pending_user_actions past expires_at gets resolved
 *      'expired' and the scheduled_post moves to status='expired'
 *
 * Self-reports to ops_cron_runs for the /ops dashboard. Auth is the
 * shared LUMO_CRON_SECRET (Vercel cron header).
 */

import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSupabase } from "@/lib/db";
import { recordCronRun } from "@/lib/ops";
import { deliver as deliverNotification } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PENDING_TTL_MINUTES = 30;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.LUMO_CRON_SECRET;
  if (!expected) return true; // dev / local — relaxed
  const provided =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    req.headers.get("x-vercel-cron") ??
    "";
  return provided === expected;
}

interface DuePost {
  id: string;
  user_id: string;
  agent_id: string;
  external_account_id: string | null;
  action_type: string;
  scheduled_for: string;
  draft_body: { text?: string };
  origin: string;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  const counts = {
    surfaced: 0,
    expired: 0,
    failed: 0,
  };
  const errors: string[] = [];
  let ok = true;

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ ok: true, note: "no DB; skipping" });
  }

  // 1) Surface newly-due queued posts.
  try {
    const nowIso = new Date().toISOString();
    const { data: dueRows, error: dueErr } = await sb
      .from("scheduled_posts")
      .select(
        "id, user_id, agent_id, external_account_id, action_type, scheduled_for, draft_body, origin",
      )
      .eq("status", "queued")
      .lte("scheduled_for", nowIso)
      .limit(100);

    if (dueErr) throw new Error(`due query: ${dueErr.message}`);

    for (const post of (dueRows ?? []) as DuePost[]) {
      try {
        // Flip to pending atomically.
        const { error: updErr } = await sb
          .from("scheduled_posts")
          .update({ status: "pending" })
          .eq("id", post.id)
          .eq("status", "queued");
        if (updErr) {
          throw new Error(`mark pending: ${updErr.message}`);
        }
        // Insert pending_user_actions row.
        const expiresAt = new Date(
          Date.now() + PENDING_TTL_MINUTES * 60 * 1000,
        ).toISOString();
        const { error: pendErr } = await sb.from("pending_user_actions").insert({
          id: `pua_${randomUUID()}`,
          user_id: post.user_id,
          scheduled_post_id: post.id,
          expires_at: expiresAt,
        });
        if (pendErr) throw new Error(`pending insert: ${pendErr.message}`);

        // Notify the user.
        const platformLabel = post.agent_id;
        await deliverNotification({
          user_id: post.user_id,
          kind: "info",
          title: `Your scheduled ${platformLabel} ${post.action_type} is ready`,
          body:
            (post.draft_body?.text ?? "").slice(0, 140) +
            ` — confirm in /workspace before ${PENDING_TTL_MINUTES}m or it expires.`,
          dedup_key: `scheduled-post-ready:${post.id}`,
          payload: {
            scheduled_post_id: post.id,
            link: `/workspace?action=confirm&post=${post.id}`,
          },
        });
        counts.surfaced += 1;
      } catch (err) {
        counts.failed += 1;
        errors.push(
          `surface ${post.id}: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            240,
          ),
        );
      }
    }
  } catch (err) {
    ok = false;
    errors.push(`due-scan: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) Expire pending rows past their TTL.
  try {
    const { data: expiredRows, error: expErr } = await sb
      .from("pending_user_actions")
      .select("id, scheduled_post_id")
      .is("resolved_at", null)
      .lt("expires_at", new Date().toISOString())
      .limit(100);
    if (expErr) throw new Error(`expired query: ${expErr.message}`);

    for (const row of (expiredRows ?? []) as Array<{
      id: string;
      scheduled_post_id: string;
    }>) {
      await sb
        .from("pending_user_actions")
        .update({ resolved_at: new Date().toISOString(), resolution: "expired" })
        .eq("id", row.id);
      await sb
        .from("scheduled_posts")
        .update({ status: "expired" })
        .eq("id", row.scheduled_post_id)
        .eq("status", "pending");
      counts.expired += 1;
    }
  } catch (err) {
    ok = false;
    errors.push(`expire-sweep: ${err instanceof Error ? err.message : String(err)}`);
  }

  await recordCronRun({
    endpoint: "publish-due-posts",
    started_at: startedAt,
    finished_at: new Date(),
    ok,
    counts,
    errors,
  });

  return NextResponse.json({ ok, counts, errors: errors.slice(0, 10) });
}
