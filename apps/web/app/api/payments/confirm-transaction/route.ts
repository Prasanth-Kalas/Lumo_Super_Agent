// STUB for MOBILE-PAYMENTS-1; MERCHANT-1 replaces with real Stripe calls.
//
// POST accepts a per-transaction confirmation request from the iOS
// PaymentConfirmationCard:
//   { paymentMethodId, amountCents, currency, lineItems[],
//     transactionDigest (hex), signedConfirmationToken (base64) }
// and returns a synthetic receipt. In production MERCHANT-1
// (a) verifies the signed confirmation token against the user's
// device-bound public key, (b) calls
// `stripe.paymentIntents.create({ confirm: true, ... })` against the
// merchant-of-record account, (c) routes funds to the supplier via
// Stripe Issuing, and (d) records the transaction + receipt in
// Postgres. None of that lives here.
import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { listMethods, recordReceipt } from "@/lib/payments-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConfirmRequest {
  paymentMethodId?: string;
  amountCents?: number;
  currency?: string;
  lineItems?: Array<{ label?: string; amountCents?: number }>;
  transactionDigest?: string;
  signedConfirmationToken?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const body = (await req.json().catch(() => null)) as ConfirmRequest | null;
  if (!body) return json({ error: "invalid_json" }, 400);

  const paymentMethodId = body.paymentMethodId ?? "";
  const amountCents =
    typeof body.amountCents === "number" ? Math.trunc(body.amountCents) : -1;
  const currency = (body.currency ?? "usd").toLowerCase();
  const digest = body.transactionDigest ?? "";
  const token = body.signedConfirmationToken ?? "";

  if (!paymentMethodId) return json({ error: "missing_payment_method" }, 400);
  if (amountCents <= 0) return json({ error: "invalid_amount" }, 400);
  if (!currency.match(/^[a-z]{3}$/)) {
    return json({ error: "invalid_currency" }, 400);
  }
  if (!digest.match(/^[0-9a-f]{32,}$/)) {
    return json({ error: "invalid_transaction_digest" }, 400);
  }
  if (!token || token.length < 16) {
    return json({ error: "invalid_confirmation_token" }, 400);
  }

  const methods = listMethods(user.id);
  const method = methods.find((m) => m.id === paymentMethodId);
  if (!method) return json({ error: "payment_method_not_found" }, 404);

  const lineItems = (body.lineItems ?? []).map((item) => ({
    label: typeof item.label === "string" ? item.label : "Item",
    amountCents:
      typeof item.amountCents === "number" ? Math.trunc(item.amountCents) : 0,
  }));

  const receipt = recordReceipt(user.id, {
    transactionId: `txn_test_${randomHex(16)}`,
    amountCents,
    currency,
    paymentMethodId,
    paymentMethodLabel: `${method.brand.toUpperCase()} •• ${method.last4}`,
    lineItems,
    status: "succeeded",
  });

  return json({ ok: true, receipt });
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
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
