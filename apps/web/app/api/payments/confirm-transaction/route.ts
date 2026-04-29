import { getSupabase } from "@/lib/db";
import {
  assertTransactionDigestHex,
  hashSignedConfirmationToken,
  verifyConfirmationToken,
} from "@/lib/merchant/confirmation-keys";
import {
  createPaymentIntent,
  listPaymentMethods,
  paymentMethodLabel,
} from "@/lib/merchant/stripe";
import {
  buildReceipt,
  digestForTitlePayload,
  ensurePaymentCustomer,
  errorResponse,
  json,
  lineItemsTotal,
  mirrorPaymentMethods,
  normalizeLineItems,
  requirePaymentUser,
  sha256Hex,
  type LineItem,
} from "@/app/api/payments/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAYMENTS_AGENT_ID = "lumo-payments";
const PAYMENTS_AGENT_VERSION = "merchant-1";
const PAYMENTS_CAPABILITY_ID = "capture_payment";

interface ConfirmRequest {
  paymentMethodId?: unknown;
  amountCents?: unknown;
  currency?: unknown;
  lineItems?: unknown;
  transactionDigest?: unknown;
  signedConfirmationToken?: unknown;
  deviceId?: unknown;
  transactionTitle?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const db = getSupabase();
  if (!db) return json({ error: "db_unavailable" }, 503);

  let transactionIdForFailure: string | null = null;
  try {
    const user = await requirePaymentUser();
    const body = (await req.json().catch(() => null)) as ConfirmRequest | null;
    if (!body) return json({ error: "invalid_json" }, 400);

    const paymentMethodId = typeof body.paymentMethodId === "string" ? body.paymentMethodId.trim() : "";
    const amountCents = typeof body.amountCents === "number" ? Math.trunc(body.amountCents) : -1;
    const currency = typeof body.currency === "string" ? body.currency.trim().toLowerCase() : "usd";
    const lineItems = normalizeLineItems(body.lineItems);
    const transactionDigest = typeof body.transactionDigest === "string" ? body.transactionDigest : "";
    const signedConfirmationToken =
      typeof body.signedConfirmationToken === "string" ? body.signedConfirmationToken : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;
    const transactionTitle = typeof body.transactionTitle === "string" ? body.transactionTitle : null;

    if (!paymentMethodId) return json({ error: "missing_payment_method" }, 400);
    if (amountCents <= 0) return json({ error: "invalid_amount" }, 400);
    if (!/^[a-z]{3}$/.test(currency)) return json({ error: "invalid_currency" }, 400);
    if (!lineItems) return json({ error: "invalid_line_items" }, 400);
    if (lineItemsTotal(lineItems) !== amountCents) {
      return json({ error: "amount_mismatch" }, 400);
    }
    const digest = assertTransactionDigestHex(transactionDigest);

    if (transactionTitle) {
      const expected = digestForTitlePayload({
        title: transactionTitle,
        currency,
        lineItems,
      });
      if (expected !== digest) return json({ error: "transaction_digest_mismatch" }, 400);
    }

    const verified = await verifyConfirmationToken({
      userId: user.id,
      deviceId,
      transactionDigest: digest,
      signedTokenBase64: signedConfirmationToken,
      db,
    });
    if (!verified.ok) return json({ error: verified.error }, 400);

    const customer = await ensurePaymentCustomer(user);
    const methods = await listPaymentMethods({ customerId: customer.stripe_customer_id });
    await mirrorPaymentMethods({
      userId: user.id,
      customerId: customer.stripe_customer_id,
      methods,
    });
    const paymentMethod = methods.find((method) => method.id === paymentMethodId);
    if (!paymentMethod) return json({ error: "payment_method_not_found" }, 404);

    const idempotencyKey = `merchant:payment:${user.id}:${digest}`;
    const { data: existing } = await db
      .from("transactions")
      .select("*")
      .eq("user_id", user.id)
      .eq("agent_id", PAYMENTS_AGENT_ID)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existing) {
      return json({
        ok: true,
        receipt: buildReceipt({
          transactionId: existing.id,
          amountCents: existing.captured_amount_cents || existing.authorized_amount_cents,
          currency: existing.currency,
          paymentMethod,
          lineItems: (existing.line_items as LineItem[]) ?? lineItems,
          createdAt: existing.created_at,
          status: existing.status === "committed" ? "succeeded" : "failed",
        }),
      });
    }

    const { data: transaction, error: insertError } = await db
      .from("transactions")
      .insert({
        user_id: user.id,
        agent_id: PAYMENTS_AGENT_ID,
        agent_version: PAYMENTS_AGENT_VERSION,
        provider: "stripe_payments",
        capability_id: PAYMENTS_CAPABILITY_ID,
        idempotency_key: idempotencyKey,
        status: "executing",
        currency: currency.toUpperCase(),
        authorized_amount_cents: amountCents,
        captured_amount_cents: 0,
        refunded_amount_cents: 0,
        stripe_customer_id: customer.stripe_customer_id,
        payment_method_id: paymentMethodId,
        confirmation_device_id: deviceId,
        confirmation_key_id: verified.key.id,
        confirmation_digest: digest,
        signed_confirmation_hash: verified.tokenHash,
        payment_method_label: paymentMethodLabel(paymentMethod),
        line_items: lineItems,
        evidence: {
          source: "merchant_1_confirm_transaction",
          digest_rederived: Boolean(transactionTitle),
          transaction_title_present: Boolean(transactionTitle),
        },
      })
      .select("*")
      .single();
    if (insertError || !transaction) {
      return json({ error: "transaction_insert_failed", message: insertError?.message }, 500);
    }
    transactionIdForFailure = transaction.id;

    await db.from("transaction_legs").insert({
      transaction_id: transaction.id,
      step_order: 0,
      provider: "stripe_payments",
      capability_id: PAYMENTS_CAPABILITY_ID,
      idempotency_key: idempotencyKey,
      status: "in_flight",
      amount_cents: amountCents,
      currency: currency.toUpperCase(),
      request_payload_hash: sha256Hex(JSON.stringify({ paymentMethodId, amountCents, currency, lineItems })),
      evidence: { source: "merchant_1_confirm_transaction" },
    });

    const payment = await createPaymentIntent({
      amountCents,
      currency,
      customerId: customer.stripe_customer_id,
      paymentMethodId,
      idempotencyKey,
      metadata: {
        lumo_transaction_id: transaction.id,
        lumo_user_id: user.id,
        lumo_capability_id: PAYMENTS_CAPABILITY_ID,
      },
    });
    const chargeId = latestChargeId(payment.paymentIntent);
    const status = payment.status;
    const receiptStatus = status === "committed" ? "succeeded" : "failed";
    const now = new Date().toISOString();

    const { data: updatedTransaction, error: updateError } = await db
      .from("transactions")
      .update({
        status,
        payment_intent_id: payment.paymentIntent.id,
        stripe_charge_id: chargeId,
        captured_amount_cents: status === "committed" ? amountCents : 0,
        evidence: {
          source: "merchant_1_confirm_transaction",
          payment_intent_status: payment.paymentIntent.status,
          digest_rederived: Boolean(transactionTitle),
        },
      })
      .eq("id", transaction.id)
      .select("*")
      .single();
    if (updateError || !updatedTransaction) {
      return json({ error: "transaction_update_failed", message: updateError?.message }, 500);
    }

    await db
      .from("transaction_legs")
      .update({
        status: status === "committed" ? "committed" : "manual_review",
        provider_reference: payment.paymentIntent.id,
        provider_status: payment.paymentIntent.status,
        response_payload_hash: sha256Hex(JSON.stringify(payment.paymentIntent)),
      })
      .eq("transaction_id", transaction.id)
      .eq("step_order", 0);

    await recordMerchantAuditAndCost({
      userId: user.id,
      transactionId: transaction.id,
      amountCents,
      status,
      createdAt: now,
    });

    return json({
      ok: true,
      receipt: buildReceipt({
        transactionId: transaction.id,
        amountCents,
        currency,
        paymentMethod,
        lineItems,
        createdAt: updatedTransaction.created_at ?? now,
        status: receiptStatus,
      }),
    });
  } catch (error) {
    if (transactionIdForFailure) {
      await db
        .from("transactions")
        .update({
          status: "failed",
          evidence: {
            source: "merchant_1_confirm_transaction",
            error: error instanceof Error ? error.message : String(error),
          },
        })
        .eq("id", transactionIdForFailure);
      await db
        .from("transaction_legs")
        .update({
          status: "failed",
          provider_status: "payment_intent_failed",
        })
        .eq("transaction_id", transactionIdForFailure)
        .eq("step_order", 0);
    }
    return errorResponse(error);
  }
}

function latestChargeId(paymentIntent: { latest_charge?: string | { id?: string } | null }): string | null {
  const charge = paymentIntent.latest_charge;
  if (!charge) return null;
  if (typeof charge === "string") return charge;
  return charge.id ?? null;
}

async function recordMerchantAuditAndCost(input: {
  userId: string;
  transactionId: string;
  amountCents: number;
  status: string;
  createdAt: string;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const estimatedStripeFeeUsd =
    input.status === "committed"
      ? Number(((input.amountCents / 100) * 0.029 + 0.3).toFixed(6))
      : 0;
  await db.from("agent_action_audit").insert({
    user_id: input.userId,
    agent_id: PAYMENTS_AGENT_ID,
    agent_version: PAYMENTS_AGENT_VERSION,
    capability_id: PAYMENTS_CAPABILITY_ID,
    scope_used: "payments.charge",
    action: input.status === "committed" ? "merchant.payment_committed" : "merchant.payment_failed",
    request_id: input.transactionId,
    evidence_hash: sha256Hex(JSON.stringify({
      transaction_id: input.transactionId,
      amount_cents: input.amountCents,
      status: input.status,
    })),
    evidence: {
      transaction_id: input.transactionId,
      amount_cents: input.amountCents,
      status: input.status,
      source: "merchant_1",
    },
  });
  await db.from("agent_cost_log").insert({
    request_id: input.transactionId,
    user_id: input.userId,
    agent_id: PAYMENTS_AGENT_ID,
    agent_version: PAYMENTS_AGENT_VERSION,
    capability_id: PAYMENTS_CAPABILITY_ID,
    connector_calls: 1,
    connector_calls_usd: estimatedStripeFeeUsd,
    cost_usd_total: estimatedStripeFeeUsd,
    cost_usd_platform: estimatedStripeFeeUsd,
    cost_usd_developer_share: 0,
    total_usd: estimatedStripeFeeUsd,
    status: input.status === "committed" ? "completed" : "aborted_error",
    evidence: {
      source: "merchant_1",
      transaction_id: input.transactionId,
      fee_model: "stripe_test_estimate_2_9pct_plus_30c",
    },
    created_at: input.createdAt,
  });
}
