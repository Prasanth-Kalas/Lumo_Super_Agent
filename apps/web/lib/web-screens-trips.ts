/**
 * Pure helpers for the /trips list and /trips/[id] detail pages.
 * No DB access, no auth — just shape and format. Tested directly in
 * tests/web-screens-trips.test.mjs without spinning up Next.
 */

import type { TripHistoryRow } from "./history.js";

export type TripStatusLabel =
  | "Draft"
  | "Confirmed"
  | "Dispatching"
  | "Booked"
  | "Cancelled"
  | "Failed";

export interface TripCardSummary {
  trip_id: string;
  title: string;
  status: TripStatusLabel;
  total: string | null;
  leg_count: number;
  created_at: string;
  cancel_requested: boolean;
  is_cancellable: boolean;
}

export function formatTripStatus(raw: string): TripStatusLabel {
  switch (raw) {
    case "draft":
      return "Draft";
    case "confirmed":
      return "Confirmed";
    case "dispatching":
      return "Dispatching";
    case "committed":
      return "Booked";
    case "rolled_back":
      return "Cancelled";
    case "rollback_failed":
      return "Failed";
    default:
      return "Draft";
  }
}

export function statusPillClass(label: TripStatusLabel): string {
  switch (label) {
    case "Booked":
      return "bg-lumo-ok/10 text-lumo-ok border-lumo-ok/30";
    case "Failed":
      return "bg-lumo-err/10 text-lumo-err border-lumo-err/30";
    case "Cancelled":
      return "bg-lumo-fg-low/10 text-lumo-fg-mid border-lumo-hair";
    case "Dispatching":
      return "bg-lumo-warn/10 text-lumo-warn border-lumo-warn/30";
    default:
      return "bg-lumo-elevated text-lumo-fg-mid border-lumo-hair";
  }
}

export function formatTotal(
  amount: string | undefined,
  currency: string | undefined,
): string | null {
  if (!amount) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const code = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${code}`;
  }
}

export function isCancellable(status: string, cancel_requested_at: string | null): boolean {
  if (cancel_requested_at) return false;
  return status === "draft" || status === "confirmed" || status === "dispatching" || status === "committed";
}

export function summarize(row: TripHistoryRow): TripCardSummary {
  const label = formatTripStatus(row.status);
  return {
    trip_id: row.trip_id,
    title: row.payload.trip_title?.trim() || "Untitled trip",
    status: label,
    total: formatTotal(row.payload.total_amount, row.payload.currency),
    leg_count: row.payload.legs?.length ?? 0,
    created_at: row.created_at,
    cancel_requested: row.cancel_requested_at !== null,
    is_cancellable: isCancellable(row.status, row.cancel_requested_at),
  };
}

export function findTripForUser(
  rows: TripHistoryRow[],
  trip_id: string,
): TripHistoryRow | null {
  for (const r of rows) {
    if (r.trip_id === trip_id) return r;
  }
  return null;
}
