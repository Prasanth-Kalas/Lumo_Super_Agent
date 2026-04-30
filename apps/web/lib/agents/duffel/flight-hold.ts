import {
  createDuffelClient,
  DuffelError,
  type DuffelClient,
} from "./client.ts";

export interface HoldResult {
  orderId: string;
  bookingReference: string | null;
  totalAmount: string;
  totalCurrency: string;
  paymentRequiredBy: string | null;
  priceGuaranteeExpiresAt: string | null;
}

export async function createHold(
  offerId: string,
  passengers: Array<Record<string, unknown>>,
  client: DuffelClient = createDuffelClient(),
): Promise<HoldResult> {
  const latestOffer = await client.getOffer(offerId);
  if (latestOffer.payment_requirements?.requires_instant_payment !== false) {
    throw new DuffelError(
      "duffel_offer_not_holdable",
      "This Duffel offer requires instant payment and cannot be held.",
      409,
    );
  }
  const order = await client.createOrder({
    offerId: latestOffer.id,
    passengers,
    hold: true,
  });
  return {
    orderId: order.id,
    bookingReference: order.booking_reference ?? null,
    totalAmount: order.total_amount,
    totalCurrency: order.total_currency,
    paymentRequiredBy: order.payment_status?.payment_required_by ?? null,
    priceGuaranteeExpiresAt: order.payment_status?.price_guarantee_expires_at ?? null,
  };
}
