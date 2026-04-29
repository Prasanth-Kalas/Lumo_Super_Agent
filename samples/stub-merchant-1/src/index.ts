import { readFileSync } from "node:fs";
import {
  buildConfirmationCard,
  defineSampleAgent,
  inMinutes,
  stableHash,
  type SampleAgentContext,
  type SampleAgentResult,
} from "../../_shared/runtime.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../lumo-agent.json", import.meta.url), "utf8"),
);

interface TestReservationOutputs extends Record<string, unknown> {
  reservation_id: string;
  payment_intent_id: string;
  transaction_id: string;
  amount_cents: number;
  currency: string;
  idempotency_key: string;
  cached?: boolean;
}

interface TestReservationRefundOutputs extends Record<string, unknown> {
  refund_id: string;
  payment_intent_id: string;
  amount_cents: number;
  currency: string;
}

export default defineSampleAgent({
  manifest,
  capabilities: {
    book_test_reservation: async (inputs, ctx) => bookTestReservation(inputs, ctx),
    refund_test_reservation: async (inputs, ctx) => refundTestReservation(inputs, ctx),
  },
});

async function bookTestReservation(
  inputs: Record<string, unknown>,
  ctx: SampleAgentContext,
): Promise<SampleAgentResult<TestReservationOutputs>> {
  const amountCents = centsInput(inputs.amount_cents) ?? 100;
  const currency = stringInput(inputs.currency)?.toUpperCase() ?? "USD";
  const idempotencyKey = stringInput(inputs.idempotency_key) ?? ctx.request_id;
  const paymentMethodId =
    stringInput(inputs.payment_method_id) ?? "pm_card_visa_lumo_test";
  const confirmationDigest = stableHash({
    amount_cents: amountCents,
    currency,
    idempotency_key: idempotencyKey,
    payment_method_id: paymentMethodId,
  });

  if (inputs.confirmed !== true) {
    const card = buildConfirmationCard({
      title: "Book test reservation",
      body: `Charge ${formatUsd(amountCents)} in Stripe Test mode and create a synthetic reservation.`,
      side_effect_summary:
        "Creates a Stripe PaymentIntent and a mock merchant reservation. Refundable for seven days.",
      reversibility: "compensating",
      expires_at: inMinutes(ctx.now(), 10),
      amount_cents: amountCents,
      currency,
      metadata: {
        idempotency_key: idempotencyKey,
        payment_method_id: paymentMethodId,
        transaction_digest: confirmationDigest,
      },
    });
    return {
      status: "needs_confirmation",
      confirmation_card: card,
      outputs: {
        reservation_id: "",
        payment_intent_id: "",
        transaction_id: "",
        amount_cents: amountCents,
        currency,
        idempotency_key: idempotencyKey,
      },
      provenance_evidence: {
        sources: [{ type: "confirmation.digest", ref: confirmationDigest }],
        redaction_applied: false,
      },
      cost_actuals: { usd: 0.006, calls: 1 },
    };
  }

  const stateKey = `stub-merchant-1:${idempotencyKey}`;
  const cached = await ctx.state.get<SampleAgentResult<TestReservationOutputs>>(stateKey);
  if (cached) {
    return {
      ...cached,
      outputs: {
        ...(cached.outputs as TestReservationOutputs),
        cached: true,
      },
    };
  }

  const paymentIntent = await createPaymentIntent(ctx, {
    amount_cents: amountCents,
    currency,
    idempotency_key: idempotencyKey,
    payment_method_id: paymentMethodId,
  });
  const reservation = await createReservation(ctx, {
    payment_intent_id: paymentIntent.payment_intent_id,
    idempotency_key: idempotencyKey,
  });

  const result: SampleAgentResult<TestReservationOutputs> = {
    status: "succeeded",
    outputs: {
      reservation_id: reservation.reservation_id,
      payment_intent_id: paymentIntent.payment_intent_id,
      transaction_id: paymentIntent.transaction_id,
      amount_cents: amountCents,
      currency,
      idempotency_key: idempotencyKey,
    },
    provenance_evidence: {
      sources: [
        { type: "connector.stripe-payments", ref: paymentIntent.payment_intent_id },
        { type: "connector.mock-merchant", ref: reservation.reservation_id },
        { type: "idempotency", ref: idempotencyKey, hash: stableHash(inputs) },
      ],
      redaction_applied: true,
    },
    cost_actuals: { usd: 0.031, calls: 2 },
  };
  await ctx.state.set(stateKey, result);
  return result;
}

async function refundTestReservation(
  inputs: Record<string, unknown>,
  ctx: SampleAgentContext,
): Promise<SampleAgentResult<TestReservationRefundOutputs>> {
  const paymentIntentId = stringInput(inputs.payment_intent_id);
  if (!paymentIntentId) {
    throw new Error("payment_intent_id is required");
  }
  const amountCents = centsInput(inputs.amount_cents) ?? 100;
  const currency = stringInput(inputs.currency)?.toUpperCase() ?? "USD";
  const stripe = ctx.connectors["stripe-payments"];
  const refund = stripe?.refundPaymentIntent
    ? ((await stripe.refundPaymentIntent({
        payment_intent_id: paymentIntentId,
        amount_cents: amountCents,
      })) as { refund_id: string })
    : { refund_id: "re_stub_merchant_001" };

  return {
    status: "succeeded",
    outputs: {
      refund_id: refund.refund_id,
      payment_intent_id: paymentIntentId,
      amount_cents: amountCents,
      currency,
    },
    provenance_evidence: {
      sources: [{ type: "connector.stripe-payments", ref: refund.refund_id }],
      redaction_applied: true,
    },
    cost_actuals: { usd: 0.018, calls: 1 },
  };
}

async function createPaymentIntent(
  ctx: SampleAgentContext,
  input: {
    amount_cents: number;
    currency: string;
    idempotency_key: string;
    payment_method_id: string;
  },
): Promise<{ payment_intent_id: string; transaction_id: string }> {
  const stripe = ctx.connectors["stripe-payments"];
  if (stripe?.createPaymentIntent) {
    return (await stripe.createPaymentIntent(input)) as {
      payment_intent_id: string;
      transaction_id: string;
    };
  }
  return {
    payment_intent_id: "pi_stub_merchant_001",
    transaction_id: "txn_stub_merchant_001",
  };
}

async function createReservation(
  ctx: SampleAgentContext,
  input: {
    payment_intent_id: string;
    idempotency_key: string;
  },
): Promise<{ reservation_id: string }> {
  const merchant = ctx.connectors["mock-merchant"];
  if (merchant?.reserve) {
    return (await merchant.reserve(input)) as { reservation_id: string };
  }
  return { reservation_id: "res_stub_merchant_001" };
}

function centsInput(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
