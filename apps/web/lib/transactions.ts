/**
 * Transactions reader for the consumer /receipts list and detail pages.
 * Reads from public.transactions and public.transaction_legs (MERCHANT-1,
 * migration 043). Every read is scoped to a user_id; the route handler
 * is responsible for resolving the authed user before calling in.
 *
 * If Supabase isn't configured we return empty arrays / null rather
 * than throwing so dev without env doesn't break the receipts page.
 */

import { getSupabase } from "./db.js";

export interface TransactionRow {
  id: string;
  user_id: string;
  agent_id: string;
  agent_version: string;
  provider: string;
  status: string;
  currency: string;
  authorized_amount_cents: number;
  captured_amount_cents: number;
  refunded_amount_cents: number;
  payment_method_label: string | null;
  line_items: Array<{
    description?: string;
    amount_cents?: number;
    quantity?: number;
  }>;
  receipt_url: string | null;
  refund_of_transaction_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionLegRow {
  id: string;
  transaction_id: string;
  step_order: number;
  provider: string;
  capability_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  provider_reference: string | null;
  created_at: string;
}

const COLS =
  "id, user_id, agent_id, agent_version, provider, status, currency, " +
  "authorized_amount_cents, captured_amount_cents, refunded_amount_cents, " +
  "payment_method_label, line_items, receipt_url, refund_of_transaction_id, " +
  "created_at, updated_at";

export async function listForUser(
  user_id: string,
  limit = 50,
): Promise<TransactionRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("transactions")
    .select(COLS)
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));
  if (error) {
    console.error("[transactions] listForUser failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as TransactionRow[];
}

export async function getForUser(
  user_id: string,
  id: string,
): Promise<TransactionRow | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("transactions")
    .select(COLS)
    .eq("user_id", user_id)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[transactions] getForUser failed:", error.message);
    return null;
  }
  return (data as unknown as TransactionRow | null) ?? null;
}

export async function listLegsFor(
  transaction_id: string,
): Promise<TransactionLegRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("transaction_legs")
    .select(
      "id, transaction_id, step_order, provider, capability_id, status, amount_cents, currency, provider_reference, created_at",
    )
    .eq("transaction_id", transaction_id)
    .order("step_order", { ascending: true });
  if (error) {
    console.error("[transactions] listLegsFor failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as TransactionLegRow[];
}
