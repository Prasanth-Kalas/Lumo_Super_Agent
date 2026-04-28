import { readFile } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { recordCronRun } from "@/lib/ops";
import { seedKnowledgeGraphFixture } from "@/lib/knowledge-graph";
import type { KnowledgeGraphFixture } from "@/lib/knowledge-graph-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENDPOINT = "/api/cron/kg-reconcile";

export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const startedAt = new Date();
  const enabled = process.env.LUMO_KG_RECONCILE_ENABLED === "true";
  if (!enabled) {
    const counts = { disabled: 1, nodes_validated: 0, edges_validated: 0 };
    await recordCronRun({
      endpoint: ENDPOINT,
      started_at: startedAt,
      finished_at: new Date(),
      ok: true,
      counts,
      errors: [],
    });
    return NextResponse.json({ ok: true, skipped: "disabled", counts });
  }

  const dryRun = new URL(req.url).searchParams.get("dry_run") !== "0";
  const fixture = await loadSyntheticFixture();
  const syntheticUser = fixture.user?.id;
  if (!syntheticUser) {
    return NextResponse.json({ ok: false, error: "synthetic_user_missing" }, { status: 500 });
  }
  const result = await seedKnowledgeGraphFixture(syntheticUser, fixture, { apply: !dryRun });
  const counts = {
    nodes_validated: result.node_count,
    edges_validated: result.edge_count,
    rows_applied: result.applied ? result.node_count + result.edge_count : 0,
  };
  await recordCronRun({
    endpoint: ENDPOINT,
    started_at: startedAt,
    finished_at: new Date(),
    ok: result.ok,
    counts,
    errors: result.errors,
  });
  return NextResponse.json({ ...result, dry_run: dryRun, counts }, { status: result.ok ? 200 : 500 });
}

function authorizeCron(req: NextRequest):
  | { ok: true }
  | { ok: false; status: number; error: string } {
  const expected = process.env.CRON_SECRET ?? process.env.LUMO_CRON_SECRET;
  if (!expected) {
    return { ok: false, status: 503, error: "cron_secret_missing" };
  }
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = bearer ?? req.headers.get("x-vercel-cron") ?? "";
  if (provided !== expected) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

async function loadSyntheticFixture(): Promise<KnowledgeGraphFixture> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "vegas-kg-synthetic.json");
  return JSON.parse(await readFile(fixturePath, "utf8")) as KnowledgeGraphFixture;
}
