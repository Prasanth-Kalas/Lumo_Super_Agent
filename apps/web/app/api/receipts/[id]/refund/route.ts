/**
 * POST /api/receipts/[id]/refund
 *
 * STUB — real refund flow lands in PAYMENTS-REFUND-1. This endpoint
 * exists so the /receipts/[id] page can wire its "Initiate refund"
 * button to a real URL today and the future sprint can swap the
 * implementation without touching the consumer surface.
 *
 * Behavior in v1:
 *   - Verifies the requester owns the transaction (404 otherwise).
 *   - Verifies the transaction is in a state that COULD be refunded
 *     (committed, with captured > refunded).
 *   - Records the request in an in-memory log so the page can show
 *     "we received your request" and the test can assert it.
 *   - Does NOT mutate transactions.refunded_amount_cents — the real
 *     swap will run that through Stripe + the saga compensation path.
 *
 * Response: { received: true, request_id: string }
 */

import { requireServerUser } from "@/lib/auth";
import { getForUser } from "@/lib/transactions";
import { recordRefundRequest } from "@/lib/refund-requests-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RefundBody {
  reason?: string;
}

export async function POST(
  req: Request,
  ctx: { params: { id: string } },
): Promise<Response> {
  const user = await requireServerUser();
  const { id } = ctx.params;
  if (!id) {
    return json({ error: "missing_id" }, 400);
  }
  let body: RefundBody = {};
  try {
    body = (await req.json()) as RefundBody;
  } catch {
    // empty body is OK
  }
  const tx = await getForUser(user.id, id);
  if (!tx) {
    return json({ error: "receipt_not_found" }, 404);
  }
  if (
    tx.status !== "committed" ||
    tx.captured_amount_cents <= tx.refunded_amount_cents
  ) {
    return json({ error: "not_refundable", status: tx.status }, 409);
  }
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
  const request_id = recordRefundRequest({
    user_id: user.id,
    transaction_id: tx.id,
    reason,
    requested_at: new Date().toISOString(),
  });
  return json({ received: true, request_id });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
