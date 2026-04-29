import type { NextRequest } from "next/server";
import { listReviewQueue, type ReviewQueueState, type ReviewRequestType } from "@/lib/trust/queue";
import { json, requireAdminUser } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const auth = await requireAdminUser();
  if (!auth.ok) return auth.response;
  const state = req.nextUrl.searchParams.get("state") as ReviewQueueState | null;
  const requestType = req.nextUrl.searchParams.get("request_type") as ReviewRequestType | null;
  try {
    const queue = await listReviewQueue({ state, requestType });
    return json({ queue });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "queue_read_failed" }, 500);
  }
}
