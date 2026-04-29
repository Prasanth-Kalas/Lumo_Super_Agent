import type { NextRequest } from "next/server";
import { getReviewQueueItem, recordReviewDecision } from "@/lib/trust/queue";
import { json, readJson, requireAdminUser, stringField } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const auth = await requireAdminUser();
  if (!auth.ok) return auth.response;
  const item = await getReviewQueueItem(params.id);
  if (!item) return json({ error: "review_not_found" }, 404);
  return json({ item });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const auth = await requireAdminUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const outcome = stringField(body, "outcome");
  if (!["approve", "reject", "needs_changes", "withdraw"].includes(outcome)) {
    return json({ error: "invalid_outcome" }, 400);
  }
  const reasonCodes = Array.isArray(body.reason_codes)
    ? body.reason_codes.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if (outcome !== "approve" && reasonCodes.length === 0) {
    return json({ error: "reason_code_required" }, 400);
  }
  try {
    await recordReviewDecision({
      queueId: params.id,
      reviewerId: auth.user.id,
      reviewerEmail: auth.user.email ?? null,
      outcome: outcome as "approve" | "reject" | "needs_changes" | "withdraw",
      reasonCodes,
      notes: stringField(body, "notes") || null,
    });
    return json({ ok: true });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "decision_failed" }, 500);
  }
}
