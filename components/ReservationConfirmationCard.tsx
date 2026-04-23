"use client";

/**
 * ReservationConfirmationCard
 *
 * Rendered in-thread when the orchestrator receives a
 * `structured-reservation` summary frame from the shell. The payload
 * shape is the canonical summary the Restaurant Agent hashes (see
 * Lumo_Restaurant_Agent_Web/lib/opentable-stub.ts ::
 * canonicalReservationSummary). This component is display-only — it
 * MUST NOT mutate or re-shape the payload, or the hash check in the
 * server will fail and return 409 confirmation_required.
 *
 * Confirm fires `Yes, book it.` → the orchestrator calls
 * `restaurant_create_reservation` with the summary_hash that the shell
 * computed. Cancel drops the hold. The parent is responsible for
 * locking the card once a decision has been made — we expose
 * `disabled` and `decidedLabel` as the single levers for that.
 */

import { useMemo } from "react";

export interface ReservationPayload {
  kind: "structured-reservation";
  slot_id: string;
  restaurant_id: string;
  restaurant_name: string;
  city: string;
  neighborhood?: string;
  /** ISO 8601 with local offset — "2026-05-15T19:30:00-07:00". */
  seated_at: string;
  party_size: number;
  /** Decimal string; "0.00" when free. */
  deposit_amount: string;
  deposit_currency: string;
}

export interface ReservationConfirmationCardProps {
  payload: ReservationPayload;
  onConfirm: () => void;
  onCancel: () => void;
  /** Disable both buttons (busy / already decided). */
  disabled?: boolean;
  /** Optional deciding-state label shown in place of buttons. */
  decidedLabel?: "confirmed" | "cancelled" | null;
}

function formatMoney(amount: string, currency: string): string | null {
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function ReservationConfirmationCard({
  payload,
  onConfirm,
  onCancel,
  disabled,
  decidedLabel,
}: ReservationConfirmationCardProps) {
  const depositLabel = useMemo(
    () => formatMoney(payload.deposit_amount, payload.deposit_currency),
    [payload.deposit_amount, payload.deposit_currency],
  );
  const locationLabel = [payload.neighborhood, payload.city]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      role="group"
      aria-label="Reservation confirmation"
      className="mr-auto max-w-[92%] w-full rounded-2xl border border-black/10 bg-white shadow-sm overflow-hidden"
    >
      {/* Header: restaurant name + deposit (the two things the user
          most needs to eyeball before confirming). */}
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-widest text-lumo-muted">
            Confirm reservation
          </div>
          <div className="text-base font-semibold tracking-tight text-lumo-ink truncate">
            {payload.restaurant_name}
          </div>
          {locationLabel ? (
            <div className="text-xs text-lumo-muted mt-0.5 truncate">
              {locationLabel}
            </div>
          ) : null}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] uppercase tracking-widest text-lumo-muted">
            {depositLabel ? "Hold" : "Deposit"}
          </div>
          <div className="text-2xl font-semibold tracking-tight text-lumo-ink">
            {depositLabel ?? "—"}
          </div>
        </div>
      </div>

      {/* Body: the reservation detail row. Kept minimal — the card is
          a gate, not a product page. */}
      <div className="px-5 py-3 border-t border-black/5">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-baseline">
          <div className="text-[11px] uppercase tracking-widest text-lumo-muted">
            When
          </div>
          <div className="text-sm text-lumo-ink">
            {formatDate(payload.seated_at)} · {formatTime(payload.seated_at)}
          </div>

          <div className="text-[11px] uppercase tracking-widest text-lumo-muted">
            Party
          </div>
          <div className="text-sm text-lumo-ink">
            {payload.party_size}{" "}
            <span className="text-lumo-muted">
              guest{payload.party_size === 1 ? "" : "s"}
            </span>
          </div>

          {depositLabel ? (
            <>
              <div className="text-[11px] uppercase tracking-widest text-lumo-muted">
                Hold note
              </div>
              <div className="text-sm text-lumo-ink">
                Authorized at booking. Applied toward the bill or refunded
                on arrival per house policy.
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Footer: Cancel / Confirm OR a frozen-state label once decided. */}
      <div className="px-5 py-3 border-t border-black/5 bg-lumo-paper/40 flex items-center justify-between gap-3">
        <div className="text-[11px] text-lumo-muted truncate">
          Slot <span className="font-mono">{payload.slot_id}</span>
        </div>
        {decidedLabel ? (
          <div
            className={`text-xs font-medium ${
              decidedLabel === "confirmed" ? "text-lumo-ink" : "text-lumo-muted"
            }`}
            aria-live="polite"
          >
            {decidedLabel === "confirmed"
              ? "Confirmed — holding your table…"
              : "Cancelled"}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={disabled}
              className="h-9 px-3 rounded-full border border-black/10 text-sm text-lumo-ink hover:bg-black/5 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={disabled}
              className="h-9 px-4 rounded-full bg-lumo-ink text-white text-sm font-medium hover:opacity-95 disabled:opacity-40"
            >
              Confirm reservation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
