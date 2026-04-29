import { type NextRequest, NextResponse } from "next/server";
import { runMonthlyCostDigest } from "@/lib/cost";
import { recordCronRun } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENDPOINT = "/api/cron/cost-monthly-digest";

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const startedAt = new Date();
  const result = await runMonthlyCostDigest({
    limit: intFromEnv("LUMO_COST_DIGEST_LIMIT", 1_000),
  });
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
  return Math.max(1, Math.min(10_000, Math.trunc(parsed)));
}
