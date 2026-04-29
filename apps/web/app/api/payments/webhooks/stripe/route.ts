import { getSupabase } from "@/lib/db";
import {
  constructStripeWebhookEvent,
  paymentIntentStatusToTransactionStatus,
} from "@/lib/merchant/stripe";
import { json, sha256Hex } from "@/app/api/payments/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const db = getSupabase();
  if (!db) return json({ error: "db_unavailable" }, 503);

  const rawBody = await req.text();
  let event;
  try {
    event = constructStripeWebhookEvent({
      rawBody,
      signature: req.headers.get("stripe-signature"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: "webhook_signature_invalid", message }, 400);
  }

  const payloadSha256 = sha256Hex(rawBody);
  const existing = await db
    .from("stripe_webhook_events")
    .select("event_id, processing_status")
    .eq("event_id", event.id)
    .maybeSingle();
  if (existing.data?.event_id) {
    return json({ received: true, duplicate: true });
  }

  await db.from("stripe_webhook_events").insert({
    event_id: event.id,
    event_type: event.type,
    livemode: event.livemode,
    payment_intent_id: objectPaymentIntentId(event.data.object),
    setup_intent_id: objectSetupIntentId(event.data.object),
    payload_sha256: payloadSha256,
    processing_status: "processing",
  });

  try {
    await processStripeEvent(event);
    await db
      .from("stripe_webhook_events")
      .update({
        processing_status: "processed",
        processed_at: new Date().toISOString(),
      })
      .eq("event_id", event.id);
    return json({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .from("stripe_webhook_events")
      .update({ processing_status: "failed", error_message: message })
      .eq("event_id", event.id);
    console.error("[payments] stripe webhook processing failed", event.type, message);
    return json({ error: "webhook_processing_failed", message }, 500);
  }
}

async function processStripeEvent(event: {
  type: string;
  data: { object: unknown };
}): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
      await reconcilePaymentIntent(event.data.object as StripeLikePaymentIntent, event.type);
      return;
    case "setup_intent.succeeded":
      return;
    case "charge.refunded":
      await reconcileChargeRefund(event.data.object as StripeLikeCharge);
      return;
    default:
      if (event.type.startsWith("customer.subscription.")) return;
      return;
  }
}

interface StripeLikePaymentIntent {
  id?: string;
  status?: string;
  amount?: number;
  amount_received?: number;
  latest_charge?: string | { id?: string } | null;
}

interface StripeLikeCharge {
  id?: string;
  payment_intent?: string | null;
  amount_refunded?: number;
  refunded?: boolean;
}

async function reconcilePaymentIntent(
  paymentIntent: StripeLikePaymentIntent,
  eventType: string,
): Promise<void> {
  if (!paymentIntent.id) return;
  const db = getSupabase();
  if (!db) return;
  const mapped = paymentIntentStatusToTransactionStatus(
    (paymentIntent.status ?? "requires_payment_method") as never,
  );
  const status = eventType === "payment_intent.payment_failed" ? "failed" : mapped;
  await db
    .from("transactions")
    .update({
      status,
      captured_amount_cents: status === "committed" ? paymentIntent.amount_received ?? paymentIntent.amount ?? 0 : 0,
      stripe_charge_id: latestChargeId(paymentIntent),
      evidence: {
        source: "stripe_webhook",
        event_type: eventType,
        payment_intent_status: paymentIntent.status,
      },
    })
    .eq("payment_intent_id", paymentIntent.id);
  await db
    .from("transaction_legs")
    .update({
      status: status === "committed" ? "committed" : "failed",
      provider_status: paymentIntent.status,
      provider_reference: paymentIntent.id,
    })
    .eq("provider_reference", paymentIntent.id);
}

async function reconcileChargeRefund(charge: StripeLikeCharge): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
  if (!paymentIntentId && !charge.id) return;
  const refundedAmount = charge.amount_refunded ?? 0;
  let query = db.from("transactions").update({
    status: charge.refunded ? "refunded" : "refund_pending",
    refunded_amount_cents: refundedAmount,
    evidence: {
      source: "stripe_webhook",
      event_type: "charge.refunded",
      charge_id: charge.id,
    },
  });
  query = paymentIntentId
    ? query.eq("payment_intent_id", paymentIntentId)
    : query.eq("stripe_charge_id", charge.id);
  await query;
}

function latestChargeId(paymentIntent: StripeLikePaymentIntent): string | null {
  const charge = paymentIntent.latest_charge;
  if (!charge) return null;
  if (typeof charge === "string") return charge;
  return charge.id ?? null;
}

function objectPaymentIntentId(object: unknown): string | null {
  const obj = object as { id?: unknown; payment_intent?: unknown; object?: unknown };
  if (obj.object === "payment_intent" && typeof obj.id === "string") return obj.id;
  if (typeof obj.payment_intent === "string") return obj.payment_intent;
  return null;
}

function objectSetupIntentId(object: unknown): string | null {
  const obj = object as { id?: unknown; object?: unknown };
  return obj.object === "setup_intent" && typeof obj.id === "string" ? obj.id : null;
}
