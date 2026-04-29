import {
  errorResponse,
  json,
  markPaymentMethodDetached,
  requirePaymentUser,
} from "@/app/api/payments/_shared";
import { detachPaymentMethod } from "@/lib/merchant/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { id: string };
}

export async function DELETE(_req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const id = ctx.params.id;
    if (!id) return json({ error: "missing_id" }, 400);
    const user = await requirePaymentUser();
    await detachPaymentMethod({ paymentMethodId: id });
    await markPaymentMethodDetached({ userId: user.id, paymentMethodId: id });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
