"use client";

/**
 * TimeSlotsSelectCard
 *
 * Single-select (radio) card rendered inline in the Super Agent chat
 * when the orchestrator calls `restaurant_check_availability`. Each
 * row is one time slot for a given restaurant / party size / date:
 * the human-readable time, the table size, and a deposit tag when
 * the provider requires one.
 *
 * Interaction model
 * ─────────────────
 * - Exactly one slot can be selected at a time. Selected row gets an
 *   accent left-bar and the primary CTA becomes active.
 * - Submitting emits a single natural-language turn carrying the
 *   exact `slot_id` so the orchestrator can forward it verbatim to
 *   `restaurant_create_reservation`.
 * - After the orchestrator posts the reservation-create, the shell
 *   takes over with `ReservationConfirmationCard` for the money-gate.
 *
 * Visual parity with FlightOffersSelectCard / FoodMenuSelectCard so
 * the three selection surfaces feel like one component family.
 */

import { useState } from "react";

export interface TimeSlotsSelection {
  restaurant_id: string;
  restaurant_name?: string;
  date?: string;
  party_size?: number;
  slots: Array<{
    slot_id: string;
    /** Local wall-clock ISO, e.g. "2026-05-15T19:30:00-07:00". */
    starts_at: string;
    party_size: number;
    table_type?: string;
    /** Deposit the venue holds at booking. "0" when free. */
    deposit_amount?: string;
    deposit_currency?: string;
    expires_at?: string;
  }>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    const m = /T(\d{2}):(\d{2})/.exec(iso);
    return m ? `${m[1]}:${m[2]}` : iso;
  }
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatMoney(amount?: string, currency?: string): string | null {
  if (!amount || amount === "0" || amount === "0.00") return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) return null;
  const c = currency ?? "USD";
  const sym = c === "USD" ? "$" : c === "EUR" ? "€" : c === "GBP" ? "£" : "";
  return sym ? `${sym}${n.toFixed(0)}` : `${n.toFixed(0)} ${c}`;
}

export function TimeSlotsSelectCard({
  payload,
  onSubmit,
  disabled,
  decidedLabel,
}: {
  payload: TimeSlotsSelection;
  onSubmit: (text: string) => void;
  disabled?: boolean;
  decidedLabel?: "confirmed" | "cancelled" | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const frozen = !!decidedLabel || !!disabled;

  if (!payload.slots?.length) return null;

  const submit = () => {
    if (!selectedId || frozen) return;
    const slot = payload.slots.find((s) => s.slot_id === selectedId);
    if (!slot) return;
    const party = slot.party_size ?? payload.party_size ?? 2;
    onSubmit(
      `Hold slot ${slot.slot_id} — the ${formatTime(slot.starts_at)} table for ${party}.`,
    );
  };

  const headerSubtitle = [
    payload.restaurant_name,
    payload.date ? formatDate(payload.date) : null,
    payload.party_size ? `party of ${payload.party_size}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="w-full max-w-[600px] animate-fade-up rounded-xl bg-lumo-surface border border-lumo-hair overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3.5 pb-3 border-b border-lumo-hair">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
          Reservation times
        </div>
        <div className="mt-1 text-[14px] font-medium text-lumo-fg">
          {payload.slots.length} open slot
          {payload.slots.length === 1 ? "" : "s"}
          {headerSubtitle ? (
            <span className="text-lumo-fg-mid font-normal">
              {" · "}
              {headerSubtitle}
            </span>
          ) : null}
        </div>
      </div>

      {/* Slot rows */}
      <ul
        className="divide-y divide-lumo-hair max-h-[480px] overflow-y-auto"
        role="radiogroup"
        aria-label="Available reservation times"
      >
        {payload.slots.map((s) => {
          const selected = s.slot_id === selectedId;
          const deposit = formatMoney(s.deposit_amount, s.deposit_currency);
          const party = s.party_size ?? payload.party_size ?? 2;

          return (
            <li key={s.slot_id}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => !frozen && setSelectedId(s.slot_id)}
                disabled={frozen}
                className={`w-full text-left flex items-start gap-3 px-4 py-3.5 transition-colors relative ${
                  selected
                    ? "bg-lumo-elevated"
                    : "hover:bg-lumo-elevated/60"
                } disabled:opacity-70`}
              >
                {/* Accent left-bar */}
                <span
                  aria-hidden
                  className={`absolute left-0 top-0 bottom-0 w-[2px] transition-colors ${
                    selected ? "bg-lumo-accent" : "bg-transparent"
                  }`}
                />

                {/* Radio dot */}
                <div className="mt-[3px] shrink-0">
                  <span
                    className={`block h-[16px] w-[16px] rounded-full border transition-colors ${
                      selected ? "border-lumo-accent" : "border-lumo-edge"
                    }`}
                  >
                    <span
                      className={`block m-[3px] h-[8px] w-[8px] rounded-full transition-transform ${
                        selected ? "bg-lumo-accent scale-100" : "bg-transparent scale-0"
                      }`}
                    />
                  </span>
                </div>

                {/* Body */}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[14px] font-medium text-lumo-fg num">
                      {formatTime(s.starts_at)}
                    </span>
                    <span className="text-[12px] text-lumo-fg-mid">
                      {formatDate(s.starts_at)}
                    </span>
                  </div>

                  <div className="text-[12px] text-lumo-fg-mid">
                    Table for <span className="num">{party}</span>
                    {s.table_type ? ` · ${s.table_type}` : ""}
                  </div>
                </div>

                {/* Deposit / right side */}
                <div className="shrink-0 text-right">
                  {deposit ? (
                    <>
                      <div className="text-[14px] font-medium text-lumo-fg num">
                        {deposit}
                      </div>
                      <div className="text-[10px] text-lumo-fg-low uppercase tracking-[0.1em] mt-0.5">
                        hold
                      </div>
                    </>
                  ) : (
                    <div className="text-[10.5px] text-lumo-fg-low uppercase tracking-[0.1em]">
                      no deposit
                    </div>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Footer */}
      <div className="border-t border-lumo-hair px-3 py-2.5">
        {decidedLabel === "confirmed" ? (
          <div className="text-[12px] text-lumo-ok text-center font-medium py-1">
            Selected · holding the table for confirmation
          </div>
        ) : decidedLabel === "cancelled" ? (
          <div className="text-[12px] text-lumo-fg-mid text-center py-1">
            Cancelled
          </div>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!selectedId || frozen}
            className="w-full h-9 rounded-lg text-[13px] font-medium transition-colors bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low disabled:cursor-not-allowed"
          >
            {selectedId ? "Hold this time" : "Pick a time to continue"}
          </button>
        )}
      </div>
    </div>
  );
}
