import { readFile } from "node:fs/promises";
import path from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { seedKnowledgeGraphFixture } from "@/lib/knowledge-graph";
import type { KnowledgeGraphFixture } from "@/lib/knowledge-graph-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireServerUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const useSynthetic = searchParams.get("synthetic") === "1";
  const apply = searchParams.get("apply") === "1";
  if (!useSynthetic) {
    return NextResponse.json(
      {
        ok: false,
        error: "source_not_implemented",
        message: "KG-1 currently supports the Synthetic Sam rebuild fixture; source extractors land in the next ETL slice.",
      },
      { status: 501 },
    );
  }

  const fixture = await loadSyntheticFixture();
  const result = await seedKnowledgeGraphFixture(user.id, fixture, { apply });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

async function loadSyntheticFixture(): Promise<KnowledgeGraphFixture> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "vegas-kg-synthetic.json");
  return JSON.parse(await readFile(fixturePath, "utf8")) as KnowledgeGraphFixture;
}
