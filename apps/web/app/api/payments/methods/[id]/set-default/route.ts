import {
  ensurePaymentCustomer,
  errorResponse,
  json,
  mirrorPaymentMethods,
  requirePaymentUser,
} from "@/app/api/payments/_shared";
import { setDefaultPaymentMethod } from "@/lib/merchant/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const id = ctx.params.id;
    if (!id) return json({ error: "missing_id" }, 400);
    const user = await requirePaymentUser();
    const customer = await ensurePaymentCustomer(user);
    const method = await setDefaultPaymentMethod({
      customerId: customer.stripe_customer_id,
      paymentMethodId: id,
    });
    await mirrorPaymentMethods({
      userId: user.id,
      customerId: customer.stripe_customer_id,
      methods: [method],
    });
    return json({ method });
  } catch (error) {
    return errorResponse(error);
  }
}
