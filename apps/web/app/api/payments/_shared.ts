import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { User } from "@supabase/supabase-js";
import { AuthError, requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import type { ConfirmationKeyError } from "@/lib/merchant/confirmation-keys";
import {
  getOrCreateCustomer,
  MerchantStripeError,
  paymentMethodLabel,
  projectPaymentMethod,
  type PaymentMethodShape,
  type StripeCustomerRecord,
} from "@/lib/merchant/stripe";

export interface LineItem {
  label: string;
  amountCents: number;
}

export interface ReceiptShape {
  id: string;
  transactionId: string;
  amountCents: number;
  currency: string;
  paymentMethodId: string;
  paymentMethodLabel: string;
  lineItems: LineItem[];
  createdAt: string;
  status: "succeeded" | "failed";
}

export async function requirePaymentUser(): Promise<User> {
  return requireServerUser();
}

export async function ensurePaymentCustomer(user: User): Promise<StripeCustomerRecord> {
  return getOrCreateCustomer({ userId: user.id, email: user.email ?? null });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return json({ error: error.code }, error.code === "not_authenticated" ? 401 : 403);
  }
  if (error instanceof MerchantStripeError) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  if (isConfirmationKeyError(error)) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  console.error("[payments] unhandled route error", error);
  return json({ error: "internal_error" }, 500);
}

function isConfirmationKeyError(error: unknown): error is ConfirmationKeyError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ConfirmationKeyError" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { status?: unknown }).status === "number"
  );
}

export async function mirrorPaymentMethods(input: {
  userId: string;
  customerId: string;
  methods: PaymentMethodShape[];
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db
    .from("payment_methods")
    .update({ is_default: false })
    .eq("user_id", input.userId)
    .is("detached_at", null);
  for (const method of input.methods) {
    await db.from("payment_methods").upsert({
      id: method.id,
      user_id: input.userId,
      stripe_customer_id: input.customerId,
      brand: method.brand,
      last4: method.last4,
      exp_month: method.expMonth,
      exp_year: method.expYear,
      is_default: method.isDefault,
      attached_at: method.addedAt,
      detached_at: null,
      livemode: false,
      billing_details: {},
    });
  }
}

export async function mirrorStripePaymentMethod(input: {
  userId: string;
  customerId: string;
  method: Stripe.PaymentMethod;
  isDefault: boolean;
}): Promise<PaymentMethodShape | null> {
  const projected = projectPaymentMethod(
    input.method,
    input.isDefault ? input.method.id : null,
  );
  if (!projected) return null;
  await mirrorPaymentMethods({
    userId: input.userId,
    customerId: input.customerId,
    methods: [projected],
  });
  return projected;
}

export async function markPaymentMethodDetached(input: {
  userId: string;
  paymentMethodId: string;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db
    .from("payment_methods")
    .update({ detached_at: new Date().toISOString(), is_default: false })
    .eq("user_id", input.userId)
    .eq("id", input.paymentMethodId);
}

export function normalizeLineItems(raw: unknown): LineItem[] | null {
  if (!Array.isArray(raw)) return null;
  const lineItems = raw.map((item) => {
    const candidate = item as { label?: unknown; amountCents?: unknown };
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    const amountCents =
      typeof candidate.amountCents === "number"
        ? Math.trunc(candidate.amountCents)
        : Number.NaN;
    if (!label || !Number.isFinite(amountCents) || amountCents < 0) return null;
    return { label, amountCents };
  });
  if (lineItems.some((item) => item === null)) return null;
  return lineItems as LineItem[];
}

export function lineItemsTotal(lineItems: LineItem[]): number {
  return lineItems.reduce((sum, item) => sum + item.amountCents, 0);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestForTitlePayload(args: {
  title: string;
  currency: string;
  lineItems: LineItem[];
}): string {
  const canonical =
    `${args.title}|${args.currency.toLowerCase()}|` +
    args.lineItems.map((item) => `${item.label}:${item.amountCents}`).join(",");
  return sha256Hex(canonical);
}

export function buildReceipt(input: {
  transactionId: string;
  amountCents: number;
  currency: string;
  paymentMethod: PaymentMethodShape;
  lineItems: LineItem[];
  createdAt: string;
  status: "succeeded" | "failed";
}): ReceiptShape {
  return {
    id: `rcpt_${input.transactionId.replace(/-/g, "").slice(0, 24)}`,
    transactionId: input.transactionId,
    amountCents: input.amountCents,
    currency: input.currency.toLowerCase(),
    paymentMethodId: input.paymentMethod.id,
    paymentMethodLabel: paymentMethodLabel(input.paymentMethod),
    lineItems: input.lineItems,
    createdAt: input.createdAt,
    status: input.status,
  };
}
