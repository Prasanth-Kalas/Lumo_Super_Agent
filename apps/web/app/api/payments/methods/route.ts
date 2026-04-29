import {
  ensurePaymentCustomer,
  errorResponse,
  json,
  mirrorPaymentMethods,
  requirePaymentUser,
} from "@/app/api/payments/_shared";
import { listPaymentMethods } from "@/lib/merchant/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const user = await requirePaymentUser();
    const customer = await ensurePaymentCustomer(user);
    const methods = await listPaymentMethods({
      customerId: customer.stripe_customer_id,
    });
    await mirrorPaymentMethods({
      userId: user.id,
      customerId: customer.stripe_customer_id,
      methods,
    });
    return json({ methods });
  } catch (error) {
    return errorResponse(error);
  }
}
