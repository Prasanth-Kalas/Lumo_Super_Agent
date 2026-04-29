import { type NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/db";
import { recordCronRun } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENDPOINT = "/api/cron/docs-weekly-digest";

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const startedAt = new Date();
  const result = await runDocsWeeklyDigest();
  await recordCronRun({
    endpoint: ENDPOINT,
    started_at: startedAt,
    finished_at: new Date(),
    ok: result.ok,
    counts: result.counts,
    errors: result.errors,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

async function runDocsWeeklyDigest(): Promise<{
  ok: boolean;
  counts: Record<string, number>;
  errors: string[];
  summary: Array<{ page_id: string; helpful: number; not_helpful: number; notes: number }>;
}> {
  const db = getSupabase();
  if (!db) {
    return { ok: true, counts: { feedback_rows: 0, pages: 0, notifications: 0 }, errors: [], summary: [] };
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("docs_page_feedback")
    .select("page_id, score, free_text")
    .gte("created_at", since)
    .limit(intFromEnv("LUMO_DOCS_FEEDBACK_DIGEST_LIMIT", 5_000));

  if (error) {
    return {
      ok: false,
      counts: { feedback_rows: 0, pages: 0, notifications: 0 },
      errors: [error.message],
      summary: [],
    };
  }

  const summary = summarizeFeedback((data ?? []) as Array<{
    page_id: string;
    score: number;
    free_text: string | null;
  }>);
  const notified = await notifySlack(summary);
  return {
    ok: true,
    counts: {
      feedback_rows: data?.length ?? 0,
      pages: summary.length,
      notifications: notified ? 1 : 0,
    },
    errors: [],
    summary,
  };
}

function summarizeFeedback(
  rows: Array<{ page_id: string; score: number; free_text: string | null }>,
): Array<{ page_id: string; helpful: number; not_helpful: number; notes: number }> {
  const byPage = new Map<string, { page_id: string; helpful: number; not_helpful: number; notes: number }>();
  for (const row of rows) {
    const current =
      byPage.get(row.page_id) ??
      { page_id: row.page_id, helpful: 0, not_helpful: 0, notes: 0 };
    if (row.score === 1) current.helpful += 1;
    if (row.score === -1) current.not_helpful += 1;
    if (row.free_text?.trim()) current.notes += 1;
    byPage.set(row.page_id, current);
  }
  return [...byPage.values()].sort((a, b) => {
    const aTotal = a.helpful + a.not_helpful;
    const bTotal = b.helpful + b.not_helpful;
    return b.not_helpful - a.not_helpful || bTotal - aTotal || a.page_id.localeCompare(b.page_id);
  });
}

async function notifySlack(
  summary: Array<{ page_id: string; helpful: number; not_helpful: number; notes: number }>,
): Promise<boolean> {
  const webhook = process.env.SLACK_WEBHOOK_AGENT_PLATFORM;
  if (!webhook || summary.length === 0) return false;
  const text = [
    "*Lumo agent docs weekly feedback*",
    ...summary.slice(0, 10).map((row) =>
      `- ${row.page_id}: +${row.helpful} / -${row.not_helpful}, notes ${row.notes}`,
    ),
  ].join("\n");
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return res.ok;
}

function authorizeCron(req: NextRequest):
  | { ok: true }
  | { ok: false; status: number; error: string } {
  const expected = process.env.CRON_SECRET ?? process.env.LUMO_CRON_SECRET;
  if (!expected) return { ok: false, status: 503, error: "cron_secret_missing" };
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = bearer ?? req.headers.get("x-vercel-cron") ?? "";
  if (provided !== expected) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(50_000, Math.trunc(parsed)));
}
