// STUB for MOBILE-PAYMENTS-1; MERCHANT-1 replaces with real Stripe calls.
//
// POST → marks the given payment method as the customer's default. In
// production MERCHANT-1 updates the Stripe customer's
// `invoice_settings.default_payment_method` field.
import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { resolvePaymentsUserId, setDefault } from "@/lib/payments-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const userId = await resolvePaymentsUserId(req, getServerUser);
  const { id } = await context.params;
  if (!id) return json({ error: "missing_id" }, 400);
  const method = setDefault(userId, id);
  if (!method) return json({ error: "not_found" }, 404);
  return json({ method });
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
