import { type NextRequest, NextResponse } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { assertGraphCitedHasProvenance } from "@/lib/knowledge-graph-core";
import { recallKnowledgeGraph } from "@/lib/knowledge-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MAX_HOPS = 3;
const DEFAULT_MAX_RESULTS = 10;

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireServerUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const question = stringValue(body.question) ?? stringValue(body.query);
  if (!question || question.trim().length < 3) {
    return NextResponse.json({ error: "question_required" }, { status: 400 });
  }

  const max_hops = clampInt(body.max_hops, 1, 3, DEFAULT_MAX_HOPS);
  const max_results = clampInt(body.max_results, 1, 50, DEFAULT_MAX_RESULTS);
  const result = await recallKnowledgeGraph({
    user_id: user.id,
    question,
    max_hops,
    max_results,
  });
  try {
    assertGraphCitedHasProvenance(result);
  } catch (err) {
    console.warn("[api/graph/recall] refusing graph response without provenance", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        ...result,
        answer: "I found graph candidates, but their provenance was incomplete. Falling back to regular recall.",
        citations: [],
        traversal_path: [],
        candidates: [],
        evidence: [],
        path: [],
        confidence: 0,
        evidence_mode: "vector_only",
        source: "fallback",
      },
      { status: 200 },
    );
  }

  return NextResponse.json(result);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
