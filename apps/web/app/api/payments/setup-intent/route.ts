import {
  ensurePaymentCustomer,
  errorResponse,
  json,
  requirePaymentUser,
} from "@/app/api/payments/_shared";
import { createSetupIntent } from "@/lib/merchant/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  try {
    const user = await requirePaymentUser();
    const customer = await ensurePaymentCustomer(user);
    const setupIntent = await createSetupIntent({
      customerId: customer.stripe_customer_id,
    });
    return json(setupIntent);
  } catch (error) {
    return errorResponse(error);
  }
}
