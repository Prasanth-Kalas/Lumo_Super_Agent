"use client";

/**
 * TimeSlotsSelectCard
 *
 * Single-select (radio) card rendered inline in the Super Agent chat
 * when the orchestrator calls `restaurant_check_availability`. Each row
 * is one time slot for a given restaurant / party size / date: the
 * human-readable time, the table size, and a deposit tag when the
 * provider requires one (price-tier 4 venues on the stub — the tag is
 * informational; the actual hold is displayed again on the
 * ReservationConfirmationCard for the money-gate).
 *
 * Interaction model
 * ─────────────────
 * - Exactly one slot can be selected at a time. Selected row gets the
 *   accent ring and the primary CTA becomes active.
 * - Submitting emits a single natural-language turn carrying the exact
 *   `slot_id` so the orchestrator can forward it verbatim to
 *   `restaurant_create_reservation`:
 *     "Hold slot slot_nopa_2026-05-15_1930 — the 7:30 PM table for 2."
 * - After the orchestrator posts the reservation-create, the shell
 *   takes over with `ReservationConfirmationCard` for the money-gate
 *   step (summary_hash + user_confirmed).
 *
 * Visual parity with FlightOffersSelectCard / FoodMenuSelectCard so the
 * three selection surfaces feel like a single component family.
 */

import { useState } from "react";

export interface TimeSlotsSelection {
  restaurant_id: string;
  restaurant_name?: string;
  date?: string; // ISO local date ("2026-05-15")
  party_size?: number;
  slots: Array<{
    slot_id: string;
    /** Local wall-clock ISO, e.g. "2026-05-15T19:30:00-07:00". */
    starts_at: string;
    party_size: number;
    table_type?: string; // "Patio" · "Bar" · "Dining room"
    /** Deposit the venue holds at booking (decimal string, USD). "0" when free. */
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
    // Precise handle + a human-readable tail so the thread stays
    // legible if the user scrolls back later.
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
    <div className="mr-auto max-w-[92%] ml-[34px] animate-fade-up rounded-2xl bg-lumo-surface border border-lumo-hairline shadow-card overflow-hidden">
      {/* Header strip */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-lumo-hairline bg-gradient-to-r from-lumo-accent/8 to-transparent">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-lumo-muted font-semibold">
            Reservation times — pick one
          </div>
          <div className="text-[15px] font-semibold text-lumo-ink truncate">
            {payload.slots.length} open slot
            {payload.slots.length === 1 ? "" : "s"}
            {headerSubtitle ? (
              <span className="text-lumo-muted font-normal">
                {"  ·  "}
                {headerSubtitle}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Slot rows */}
      <ul
        className="divide-y divide-lumo-hairline max-h-[480px] overflow-y-auto"
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
                className={`w-full text-left flex items-start gap-3 px-4 py-3.5 transition-colors ${
                  selected
                    ? "bg-lumo-accent/5 ring-2 ring-inset ring-lumo-accent/40"
                    : "hover:bg-black/2.5"
                } disabled:opacity-70`}
              >
                {/* Radio dot */}
                <div className="mt-1 shrink-0">
                  <span
                    className={`block h-[20px] w-[20px] rounded-full border-[1.5px] transition-all ${
                      selected
                        ? "border-lumo-accent bg-white"
                        : "border-lumo-hairline bg-white"
                    }`}
                  >
                    <span
                      className={`block m-[3px] h-[11px] w-[11px] rounded-full transition-all ${
                        selected ? "bg-lumo-accent scale-100" : "bg-transparent scale-0"
                      }`}
                    />
                  </span>
                </div>

                {/* Body */}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[15px] font-semibold text-lumo-ink tabular-nums">
                      {formatTime(s.starts_at)}
                    </span>
                    <span className="text-[12px] text-lumo-muted">
                      {formatDate(s.starts_at)}
                    </span>
                  </div>

                  <div className="text-[12.5px] text-lumo-muted">
                    Table for {party}
                    {s.table_type ? ` · ${s.table_type}` : ""}
                  </div>
                </div>

                {/* Deposit / right side */}
                <div className="shrink-0 text-right">
                  {deposit ? (
                    <>
                      <div className="text-[15px] font-semibold text-lumo-ink tabular-nums">
                        {deposit}
                      </div>
                      <div className="text-[10.5px] text-lumo-muted uppercase tracking-wider">
                        hold
                      </div>
                    </>
                  ) : (
                    <div className="text-[11.5px] text-lumo-muted uppercase tracking-wider">
                      no deposit
                    </div>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Footer CTA */}
      <div className="border-t border-lumo-hairline bg-white/60 px-4 py-3 backdrop-blur-sm">
        {decidedLabel === "confirmed" ? (
          <div className="text-[12.5px] text-emerald-700 text-center font-medium">
            Selected · holding the table for confirmation
          </div>
        ) : decidedLabel === "cancelled" ? (
          <div className="text-[12.5px] text-lumo-muted text-center">
            Cancelled
          </div>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!selectedId || frozen}
            className="w-full rounded-full bg-lumo-accent px-5 py-2.5 text-[14px] font-semibold text-white shadow-[0_6px_14px_-6px_rgba(255,107,44,0.7)] hover:bg-lumo-accentDeep disabled:bg-black/10 disabled:text-lumo-muted disabled:shadow-none transition-all"
          >
            {selectedId ? "Hold this time" : "Pick a time to continue"}
          </button>
        )}
      </div>
    </div>
  );
}
