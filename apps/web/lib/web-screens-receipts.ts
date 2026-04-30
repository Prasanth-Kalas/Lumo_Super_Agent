/**
 * Pure helpers for the /receipts list and /receipts/[id] detail pages.
 */

import type { TransactionRow } from "./transactions.js";

export type ReceiptStatusLabel =
  | "Draft"
  | "Pending"
  | "Authorized"
  | "Paid"
  | "Refunded"
  | "Partially refunded"
  | "Cancelled"
  | "Failed";

export function formatCents(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  const value = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

export function formatTransactionStatus(row: TransactionRow): ReceiptStatusLabel {
  if (row.refunded_amount_cents > 0 && row.refunded_amount_cents >= row.captured_amount_cents) {
    return "Refunded";
  }
  if (row.refunded_amount_cents > 0) {
    return "Partially refunded";
  }
  switch (row.status) {
    case "draft":
      return "Draft";
    case "awaiting_confirmation":
      return "Pending";
    case "authorized":
      return "Authorized";
    case "executing":
    case "partially_committed":
      return "Pending";
    case "committed":
      return "Paid";
    case "rolling_back":
    case "rolled_back":
      return "Cancelled";
    case "refund_pending":
      return "Pending";
    case "refunded":
      return "Refunded";
    case "failed":
      return "Failed";
    case "manual_review":
      return "Pending";
    default:
      return "Pending";
  }
}

export function statusPillClass(label: ReceiptStatusLabel): string {
  switch (label) {
    case "Paid":
      return "bg-lumo-ok/10 text-lumo-ok border-lumo-ok/30";
    case "Failed":
      return "bg-lumo-err/10 text-lumo-err border-lumo-err/30";
    case "Cancelled":
    case "Refunded":
      return "bg-lumo-fg-low/10 text-lumo-fg-mid border-lumo-hair";
    case "Authorized":
    case "Pending":
    case "Partially refunded":
      return "bg-lumo-warn/10 text-lumo-warn border-lumo-warn/30";
    default:
      return "bg-lumo-elevated text-lumo-fg-mid border-lumo-hair";
  }
}

export function isRefundable(row: TransactionRow): boolean {
  return (
    row.status === "committed" &&
    row.captured_amount_cents > row.refunded_amount_cents
  );
}

export function totalDisplayCents(row: TransactionRow): number {
  return row.captured_amount_cents > 0
    ? row.captured_amount_cents
    : row.authorized_amount_cents;
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case "duffel":
      return "Duffel · flights";
    case "booking":
      return "Booking · stays";
    case "expedia_partner_solutions":
      return "Expedia · stays";
    case "uber_for_business":
      return "Uber for Business";
    case "stripe_issuing":
      return "Stripe Issuing";
    case "stripe_payments":
      return "Stripe";
    case "mock_merchant":
      return "Test merchant";
    default:
      return provider;
  }
}
