// STUB for MOBILE-PAYMENTS-1; MERCHANT-1 replaces with real Stripe calls.
//
// In production this route calls `stripe.setupIntents.create({ customer,
// usage: 'off_session' })` and returns the resulting client_secret to
// the iOS app, which feeds it to PaymentSheet for card add. For v1 we
// return `{ stub: true, setupIntentId, clientSecret: null }` so the
// iOS PaymentService knows to render its synthetic add-card sheet
// instead of invoking real PaymentSheet (which would fail without a
// real client_secret).
import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { resolvePaymentsUserId } from "@/lib/payments-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const userId = await resolvePaymentsUserId(req, getServerUser);
  const setupIntentId = `seti_test_${randomHex(16)}`;
  return json({
    stub: true,
    setupIntentId,
    clientSecret: null,
    customerId: `cus_test_${userId.replace(/-/g, "").slice(0, 16)}`,
  });
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
