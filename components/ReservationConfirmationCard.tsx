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
 * `restaurant_create_reservation` with the summary_hash that the
 * shell computed. Cancel drops the hold. The parent is responsible
 * for locking the card once a decision has been made — we expose
 * `disabled` and `decidedLabel` as the single levers for that.
 *
 * Visual system — Linear/Vercel dark-first: 10px radius, single
 * hairline border, restrained accent reserved for the primary CTA
 * hover and the selected-state left-bar, `tabular-nums` on every
 * numeric readout.
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
      className="w-full max-w-[600px] rounded-xl border border-lumo-hair bg-lumo-surface overflow-hidden animate-fade-up"
    >
      {/* Header: restaurant name + deposit (the two things the user
          most needs to eyeball before confirming). */}
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3.5 border-b border-lumo-hair">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
            Confirm reservation
          </div>
          <div className="mt-1 text-[15px] font-semibold tracking-[-0.005em] text-lumo-fg truncate">
            {payload.restaurant_name}
          </div>
          {locationLabel ? (
            <div className="text-[12px] text-lumo-fg-mid mt-0.5 truncate">
              {locationLabel}
            </div>
          ) : null}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
            {depositLabel ? "Hold" : "Deposit"}
          </div>
          <div className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-lumo-fg num">
            {depositLabel ?? "—"}
          </div>
        </div>
      </div>

      {/* Body: the reservation detail row. Kept minimal — the card is
          a gate, not a product page. */}
      <div className="px-5 py-4">
        <dl className="grid grid-cols-[88px_1fr] gap-x-4 gap-y-2.5">
          <dt className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium pt-0.5">
            When
          </dt>
          <dd className="text-[13.5px] text-lumo-fg num">
            {formatDate(payload.seated_at)}{" "}
            <span className="text-lumo-fg-mid">·</span>{" "}
            {formatTime(payload.seated_at)}
          </dd>

          <dt className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium pt-0.5">
            Party
          </dt>
          <dd className="text-[13.5px] text-lumo-fg">
            <span className="num">{payload.party_size}</span>{" "}
            <span className="text-lumo-fg-mid">
              guest{payload.party_size === 1 ? "" : "s"}
            </span>
          </dd>

          {depositLabel ? (
            <>
              <dt className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium pt-0.5">
                Hold note
              </dt>
              <dd className="text-[12.5px] text-lumo-fg-mid leading-relaxed">
                Authorized at booking. Applied toward the bill or refunded
                on arrival per house policy.
              </dd>
            </>
          ) : null}
        </dl>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-lumo-hair flex items-center justify-between gap-3">
        <div className="text-[11px] text-lumo-fg-low truncate">
          Slot{" "}
          <span className="font-mono text-lumo-fg-mid num">
            {payload.slot_id}
          </span>
        </div>
        {decidedLabel ? (
          <div
            className={`text-[12px] font-medium ${
              decidedLabel === "confirmed" ? "text-lumo-ok" : "text-lumo-fg-mid"
            }`}
            aria-live="polite"
          >
            {decidedLabel === "confirmed"
              ? "Confirmed — holding your table…"
              : "Cancelled"}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onCancel}
              disabled={disabled}
              className="h-8 px-3 rounded-md text-[12.5px] font-medium text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={disabled}
              className="h-8 px-3.5 rounded-md text-[12.5px] font-medium bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors disabled:bg-lumo-elevated disabled:text-lumo-fg-low"
            >
              Confirm reservation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
