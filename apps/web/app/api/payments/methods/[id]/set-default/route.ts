// STUB for MOBILE-PAYMENTS-1; MERCHANT-1 replaces with real Stripe calls.
//
// POST → marks the given payment method as the customer's default. In
// production MERCHANT-1 updates the Stripe customer's
// `invoice_settings.default_payment_method` field.
import { requireServerUser } from "@/lib/auth";
import { setDefault } from "@/lib/payments-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireServerUser();
  const { id } = await context.params;
  if (!id) return json({ error: "missing_id" }, 400);
  const method = setDefault(user.id, id);
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
