import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/db";

export type MerchantStripeErrorCode =
  | "stripe_not_configured"
  | "db_unavailable"
  | "customer_lookup_failed"
  | "customer_create_failed"
  | "customer_persist_failed"
  | "setup_intent_failed"
  | "payment_methods_failed"
  | "default_payment_method_failed"
  | "detach_payment_method_failed"
  | "payment_intent_failed"
  | "refund_failed"
  | "webhook_not_configured"
  | "webhook_signature_invalid";

export class MerchantStripeError extends Error {
  readonly code: MerchantStripeErrorCode;
  readonly status: number;

  constructor(code: MerchantStripeErrorCode, message: string, status = 500) {
    super(message);
    this.name = "MerchantStripeError";
    this.code = code;
    this.status = status;
  }
}

export interface StripeCustomerRecord {
  user_id: string;
  stripe_customer_id: string;
  livemode: boolean;
  email: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PaymentMethodShape {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  addedAt: string;
}

export interface StripeSetupIntentResult {
  stub: false;
  clientSecret: string;
  setupIntentId: string;
  customerId: string;
}

export interface StripePaymentIntentResult {
  paymentIntent: Stripe.PaymentIntent;
  status: "committed" | "authorized" | "manual_review" | "failed";
}

let cachedStripe: Stripe | null | undefined;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY_TEST);
}

export function getStripe(): Stripe | null {
  if (cachedStripe !== undefined) return cachedStripe;
  const secretKey = process.env.STRIPE_SECRET_KEY_TEST;
  if (!secretKey) {
    cachedStripe = null;
    return cachedStripe;
  }
  cachedStripe = new Stripe(secretKey, {
    apiVersion: "2026-04-22.dahlia",
    appInfo: {
      name: "Lumo Super Agent",
      version: "merchant-1",
    },
  });
  return cachedStripe;
}

export function requireStripe(): Stripe {
  const stripe = getStripe();
  if (!stripe) {
    throw new MerchantStripeError(
      "stripe_not_configured",
      "Stripe is not configured. Set STRIPE_SECRET_KEY_TEST.",
      503,
    );
  }
  return stripe;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET_TEST;
  if (!secret) {
    throw new MerchantStripeError(
      "webhook_not_configured",
      "Stripe webhook signing secret is not configured. Set STRIPE_WEBHOOK_SIGNING_SECRET_TEST.",
      503,
    );
  }
  return secret;
}

export function __resetStripeForTesting(): void {
  cachedStripe = undefined;
}

function dbOrThrow(db?: SupabaseClient | null): SupabaseClient {
  const client = db ?? getSupabase();
  if (!client) {
    throw new MerchantStripeError(
      "db_unavailable",
      "Merchant persistence is unavailable. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      503,
    );
  }
  return client;
}

function stripeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function livemodeFromId(id: string): boolean {
  return !id.includes("_test_") && process.env.STRIPE_SECRET_KEY_TEST?.startsWith("sk_live_") === true;
}

function normalizeEmail(email?: string | null): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim();
  return trimmed.includes("@") ? trimmed : undefined;
}

export async function getOrCreateCustomer(input: {
  userId: string;
  email?: string | null;
  db?: SupabaseClient | null;
  stripe?: Stripe;
}): Promise<StripeCustomerRecord> {
  const db = dbOrThrow(input.db);
  const stripe = input.stripe ?? requireStripe();

  const { data: existing, error: lookupError } = await db
    .from("payments_customers")
    .select("*")
    .eq("user_id", input.userId)
    .maybeSingle();
  if (lookupError) {
    throw new MerchantStripeError(
      "customer_lookup_failed",
      lookupError.message,
      500,
    );
  }
  if (existing) return existing as StripeCustomerRecord;

  let customer: Stripe.Customer;
  try {
    customer = (await stripe.customers.create({
      email: normalizeEmail(input.email),
      metadata: { lumo_user_id: input.userId },
    })) as Stripe.Customer;
  } catch (error) {
    throw new MerchantStripeError(
      "customer_create_failed",
      stripeErrorMessage(error),
      502,
    );
  }

  const row: StripeCustomerRecord = {
    user_id: input.userId,
    stripe_customer_id: customer.id,
    livemode: Boolean(customer.livemode),
    email: normalizeEmail(input.email) ?? null,
  };
  const { data, error } = await db
    .from("payments_customers")
    .insert(row)
    .select("*")
    .single();
  if (!error && data) return data as StripeCustomerRecord;

  // Another request may have created the row between lookup and insert.
  const { data: raced, error: racedError } = await db
    .from("payments_customers")
    .select("*")
    .eq("user_id", input.userId)
    .maybeSingle();
  if (raced) return raced as StripeCustomerRecord;

  throw new MerchantStripeError(
    "customer_persist_failed",
    error?.message ?? racedError?.message ?? "Could not persist Stripe customer",
    500,
  );
}

export async function createSetupIntent(input: {
  customerId: string;
  stripe?: Stripe;
}): Promise<StripeSetupIntentResult> {
  const stripe = input.stripe ?? requireStripe();
  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: input.customerId,
      usage: "off_session",
      metadata: { lumo_flow: "mobile_payments_merchant_1" },
    });
    if (!setupIntent.client_secret) {
      throw new Error("Stripe setup intent did not include a client_secret");
    }
    return {
      stub: false,
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      customerId: input.customerId,
    };
  } catch (error) {
    if (error instanceof MerchantStripeError) throw error;
    throw new MerchantStripeError(
      "setup_intent_failed",
      stripeErrorMessage(error),
      502,
    );
  }
}

export function projectPaymentMethod(
  method: Stripe.PaymentMethod,
  defaultPaymentMethodId?: string | null,
): PaymentMethodShape | null {
  if (!method.card) return null;
  return {
    id: method.id,
    brand: method.card.brand || "unknown",
    last4: method.card.last4 || "0000",
    expMonth: method.card.exp_month,
    expYear: method.card.exp_year,
    isDefault: method.id === defaultPaymentMethodId,
    addedAt: new Date((method.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
}

export async function listPaymentMethods(input: {
  customerId: string;
  stripe?: Stripe;
}): Promise<PaymentMethodShape[]> {
  const stripe = input.stripe ?? requireStripe();
  try {
    const [customer, methods] = await Promise.all([
      stripe.customers.retrieve(input.customerId),
      stripe.paymentMethods.list({ customer: input.customerId, type: "card" }),
    ]);
    const defaultPaymentMethodId =
      !customer.deleted && typeof customer.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : null;
    return methods.data
      .map((method) => projectPaymentMethod(method, defaultPaymentMethodId))
      .filter((method): method is PaymentMethodShape => method !== null);
  } catch (error) {
    throw new MerchantStripeError(
      "payment_methods_failed",
      stripeErrorMessage(error),
      502,
    );
  }
}

export async function setDefaultPaymentMethod(input: {
  customerId: string;
  paymentMethodId: string;
  stripe?: Stripe;
}): Promise<PaymentMethodShape> {
  const stripe = input.stripe ?? requireStripe();
  try {
    await stripe.customers.update(input.customerId, {
      invoice_settings: { default_payment_method: input.paymentMethodId },
    });
    const method = await stripe.paymentMethods.retrieve(input.paymentMethodId);
    const projected = projectPaymentMethod(method, input.paymentMethodId);
    if (!projected) throw new Error("Payment method is not a card");
    return projected;
  } catch (error) {
    throw new MerchantStripeError(
      "default_payment_method_failed",
      stripeErrorMessage(error),
      502,
    );
  }
}

export async function detachPaymentMethod(input: {
  paymentMethodId: string;
  stripe?: Stripe;
}): Promise<void> {
  const stripe = input.stripe ?? requireStripe();
  try {
    await stripe.paymentMethods.detach(input.paymentMethodId);
  } catch (error) {
    throw new MerchantStripeError(
      "detach_payment_method_failed",
      stripeErrorMessage(error),
      502,
    );
  }
}

export async function createPaymentIntent(input: {
  amountCents: number;
  currency: string;
  customerId: string;
  paymentMethodId: string;
  idempotencyKey: string;
  metadata?: Stripe.MetadataParam;
  stripe?: Stripe;
}): Promise<StripePaymentIntentResult> {
  const stripe = input.stripe ?? requireStripe();
  try {
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        confirm: true,
        off_session: true,
        metadata: {
          lumo_idempotency_key: input.idempotencyKey,
          ...(input.metadata ?? {}),
        },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    const status = paymentIntentStatusToTransactionStatus(paymentIntent.status);
    return { paymentIntent, status };
  } catch (error) {
    throw new MerchantStripeError(
      "payment_intent_failed",
      stripeErrorMessage(error),
      402,
    );
  }
}

export async function refundPaymentIntent(input: {
  paymentIntentId: string;
  amountCents?: number;
  idempotencyKey?: string;
  stripe?: Stripe;
}): Promise<Stripe.Refund> {
  const stripe = input.stripe ?? requireStripe();
  try {
    return await stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountCents,
      },
      input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
    );
  } catch (error) {
    throw new MerchantStripeError("refund_failed", stripeErrorMessage(error), 502);
  }
}

export function constructStripeWebhookEvent(input: {
  rawBody: string | Buffer;
  signature: string | null;
  stripe?: Stripe;
  webhookSecret?: string;
}): Stripe.Event {
  if (!input.signature) {
    throw new MerchantStripeError(
      "webhook_signature_invalid",
      "Missing Stripe-Signature header",
      400,
    );
  }
  const stripe = input.stripe ?? requireStripe();
  try {
    return stripe.webhooks.constructEvent(
      input.rawBody,
      input.signature,
      input.webhookSecret ?? getStripeWebhookSecret(),
    );
  } catch (error) {
    throw new MerchantStripeError(
      "webhook_signature_invalid",
      stripeErrorMessage(error),
      400,
    );
  }
}

export function paymentIntentStatusToTransactionStatus(
  status: Stripe.PaymentIntent.Status,
): StripePaymentIntentResult["status"] {
  switch (status) {
    case "succeeded":
      return "committed";
    case "requires_capture":
    case "processing":
      return "authorized";
    case "requires_action":
    case "requires_confirmation":
    case "requires_payment_method":
      return "manual_review";
    case "canceled":
      return "failed";
    default:
      return "manual_review";
  }
}

export function paymentMethodLabel(method: PaymentMethodShape): string {
  return `${method.brand.toUpperCase()} •• ${method.last4}`;
}

export function merchantAccountId(): string | null {
  return process.env.STRIPE_MERCHANT_ACCOUNT_ID?.trim() || null;
}
