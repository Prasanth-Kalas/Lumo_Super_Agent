// STUB for MOBILE-PAYMENTS-1; MERCHANT-1 replaces with real Stripe calls.
//
// DELETE → removes a saved payment method from the stub store. In
// production MERCHANT-1 calls `stripe.paymentMethods.detach()` to drop
// the PaymentMethod from the customer.
import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { removeMethod, resolvePaymentsUserId } from "@/lib/payments-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const userId = await resolvePaymentsUserId(req, getServerUser);
  const { id } = await context.params;
  if (!id) return json({ error: "missing_id" }, 400);
  const ok = removeMethod(userId, id);
  if (!ok) return json({ error: "not_found" }, 404);
  return json({ ok: true });
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
