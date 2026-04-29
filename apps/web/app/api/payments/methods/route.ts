// STUB for MOBILE-PAYMENTS-1; MERCHANT-1 replaces with real Stripe calls.
//
// GET → returns the saved payment methods for the signed-in user from
// the in-memory stub store (lib/payments-stub.ts).
// POST → records a synthetic added card. The iOS PaymentService calls
// this after its synthetic add-card sheet collects card details. In
// production MERCHANT-1 attaches the PaymentMethod to the customer via
// `stripe.paymentMethods.attach()` and lets Stripe own listing.
import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import {
  addMethod,
  listMethods,
  resolvePaymentsUserId,
  type StubCardBrand,
} from "@/lib/payments-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = await resolvePaymentsUserId(req, getServerUser);
  return json({ methods: listMethods(userId) });
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = await resolvePaymentsUserId(req, getServerUser);
  const body = (await req.json().catch(() => null)) as {
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
  } | null;

  if (!body) return json({ error: "invalid_json" }, 400);
  const brand = normalizeBrand(body.brand);
  const last4 = typeof body.last4 === "string" ? body.last4.trim() : "";
  const expMonth =
    typeof body.expMonth === "number" ? Math.trunc(body.expMonth) : 0;
  const expYear =
    typeof body.expYear === "number" ? Math.trunc(body.expYear) : 0;

  if (!last4.match(/^\d{4}$/)) return json({ error: "invalid_last4" }, 400);
  if (expMonth < 1 || expMonth > 12) {
    return json({ error: "invalid_exp_month" }, 400);
  }
  if (expYear < 2024 || expYear > 2099) {
    return json({ error: "invalid_exp_year" }, 400);
  }

  const method = addMethod(userId, { brand, last4, expMonth, expYear });
  return json({ method }, 201);
}

function normalizeBrand(raw: unknown): StubCardBrand {
  const v = typeof raw === "string" ? raw.toLowerCase() : "";
  if (v === "visa" || v === "mastercard" || v === "amex" || v === "discover") {
    return v;
  }
  return "unknown";
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
