import { createHash } from "node:crypto";
import { getSupabase } from "../../db.ts";
import {
  createPaymentIntent,
  getOrCreateCustomer,
  type PaymentMethodShape,
} from "../../merchant/stripe.ts";
import {
  createDuffelClient,
  DuffelError,
  type DuffelClient,
} from "./client.ts";

export interface FlightBookingInput {
  userId: string;
  offerId: string;
  paymentMethodId: string;
  passengers: Array<Record<string, unknown>>;
  amountCents?: number;
  currency?: string;
  idempotencyKey?: string;
  paymentMethod?: PaymentMethodShape | null;
}

export interface BookingConfirmation {
  transactionId: string | null;
  orderId: string;
  bookingReference: string | null;
  status: "committed" | "manual_review";
  amountCents: number;
  currency: string;
  paymentIntentId: string;
}

const DUFFEL_AGENT_ID = "lumo-flights";
const DUFFEL_AGENT_VERSION = "mesh-1";
const BOOK_CAPABILITY_ID = "book_flight";

export async function confirmBooking(
  input: FlightBookingInput,
  client: DuffelClient = createDuffelClient(),
): Promise<BookingConfirmation> {
  const db = getSupabase();
  if (!db) {
    throw new DuffelError("duffel_booking_failed", "Supabase is required for Duffel booking.", 503);
  }
  const latestOffer = await client.getOffer(input.offerId);
  const currency = (input.currency ?? latestOffer.total_currency).toUpperCase();
  const amountCents =
    input.amountCents ?? Math.round(Number(latestOffer.total_amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new DuffelError("duffel_booking_failed", "Duffel offer amount is invalid.", 502);
  }
  const idempotencyKey =
    input.idempotencyKey ??
    `merchant:mesh:${input.userId}:${BOOK_CAPABILITY_ID}:${sha256Hex(input.offerId).slice(0, 16)}`;
  const customer = await getOrCreateCustomer({ userId: input.userId });

  const { data: existing } = await db
    .from("transactions")
    .select("*")
    .eq("user_id", input.userId)
    .eq("agent_id", DUFFEL_AGENT_ID)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing?.payment_intent_id && existing?.evidence?.duffel_order_id) {
    return {
      transactionId: existing.id,
      orderId: String(existing.evidence.duffel_order_id),
      bookingReference: String(existing.evidence.duffel_booking_reference ?? "") || null,
      status: existing.status === "committed" ? "committed" : "manual_review",
      amountCents: Number(existing.captured_amount_cents || existing.authorized_amount_cents),
      currency: String(existing.currency),
      paymentIntentId: String(existing.payment_intent_id),
    };
  }

  const { data: transaction, error: insertError } = await db
    .from("transactions")
    .insert({
      user_id: input.userId,
      agent_id: DUFFEL_AGENT_ID,
      agent_version: DUFFEL_AGENT_VERSION,
      provider: "duffel",
      capability_id: BOOK_CAPABILITY_ID,
      idempotency_key: idempotencyKey,
      status: "executing",
      currency,
      authorized_amount_cents: amountCents,
      stripe_customer_id: customer.stripe_customer_id,
      payment_method_id: input.paymentMethodId,
      payment_method_label: input.paymentMethod ? paymentMethodLabel(input.paymentMethod) : null,
      line_items: [
        {
          id: input.offerId,
          title: "Duffel flight booking",
          amountCents,
          currency,
        },
      ],
      evidence: {
        source: "mesh_1_duffel_booking",
        offer_id: input.offerId,
      },
    })
    .select("*")
    .single();
  if (insertError || !transaction) {
    throw new DuffelError(
      "duffel_booking_failed",
      insertError?.message ?? "Could not create transaction.",
      500,
    );
  }

  await db.from("transaction_legs").insert({
    transaction_id: transaction.id,
    step_order: 0,
    provider: "duffel",
    capability_id: BOOK_CAPABILITY_ID,
    compensation_capability_id: "cancel_flight",
    idempotency_key: idempotencyKey,
    status: "in_flight",
    amount_cents: amountCents,
    currency,
    request_payload_hash: sha256Hex(JSON.stringify({ offerId: input.offerId, passengers: input.passengers })),
    evidence: { source: "mesh_1_duffel_booking" },
  });

  const payment = await createPaymentIntent({
    amountCents,
    currency,
    customerId: customer.stripe_customer_id,
    paymentMethodId: input.paymentMethodId,
    idempotencyKey,
    metadata: {
      lumo_transaction_id: transaction.id,
      lumo_agent_id: DUFFEL_AGENT_ID,
      lumo_capability_id: BOOK_CAPABILITY_ID,
    },
  });
  const order = await client.createOrder({
    offerId: latestOffer.id,
    passengers: input.passengers,
    payment: {
      amount: latestOffer.total_amount,
      currency,
    },
  });
  const status = payment.status === "committed" ? "committed" : "manual_review";
  await db
    .from("transactions")
    .update({
      status,
      payment_intent_id: payment.paymentIntent.id,
      captured_amount_cents: status === "committed" ? amountCents : 0,
      evidence: {
        source: "mesh_1_duffel_booking",
        offer_id: latestOffer.id,
        duffel_order_id: order.id,
        duffel_booking_reference: order.booking_reference ?? null,
        payment_intent_status: payment.paymentIntent.status,
      },
    })
    .eq("id", transaction.id);
  await db
    .from("transaction_legs")
    .update({
      status,
      provider_reference: order.id,
      provider_status: order.awaiting_payment ? "awaiting_payment" : "booked",
      response_payload_hash: sha256Hex(JSON.stringify(order)),
      evidence: {
        duffel_order_id: order.id,
        booking_reference: order.booking_reference ?? null,
      },
    })
    .eq("transaction_id", transaction.id)
    .eq("step_order", 0);

  return {
    transactionId: transaction.id,
    orderId: order.id,
    bookingReference: order.booking_reference ?? null,
    status,
    amountCents,
    currency,
    paymentIntentId: payment.paymentIntent.id,
  };
}

export async function cancelFlightOrder(
  orderId: string,
  client: DuffelClient = createDuffelClient(),
): Promise<{ orderId: string; status: "cancelled" }> {
  await client.cancelOrder(orderId);
  return { orderId, status: "cancelled" };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function paymentMethodLabel(method: PaymentMethodShape): string {
  return `${method.brand.toUpperCase()} •••• ${method.last4}`;
}
