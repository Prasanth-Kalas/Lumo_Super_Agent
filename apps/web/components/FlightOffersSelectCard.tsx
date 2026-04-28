"use client";

/**
 * FlightOffersSelectCard
 *
 * Single-select (radio) offers card rendered inline in the Super Agent
 * chat when the orchestrator calls `flight_search_offers`. Each row
 * shows one Duffel-shaped offer: carrier + flight numbers, depart →
 * arrive, duration, stop-count, and price on the right.
 *
 * Interaction model
 * ─────────────────
 * - Exactly one offer can be selected at a time (radio semantics).
 *   The selected row gets an accent-tinted left border and the primary
 *   CTA becomes active.
 * - Submitting emits a single natural-language turn back into the
 *   chat stream, carrying the exact `offer_id` so the orchestrator
 *   can forward it to `flight_price_offer` without ambiguity.
 * - After the orchestrator prices the chosen offer, the existing
 *   `ItineraryConfirmationCard` takes over for the money-gate step.
 *
 * Visual system — Linear/Vercel dark-first: single deliberate
 * hairline shadow, 10px card radius, `tabular-nums` on every number,
 * no emoji, single restrained accent.
 */

import { useState } from "react";

export interface FlightOffersSelection {
  offers: Array<{
    offer_id: string;
    total_amount: string; // Duffel returns stringified decimal
    total_currency: string;
    owner: { name: string; iata_code: string };
    slices: Array<{
      origin: { iata_code: string; city_name?: string };
      destination: { iata_code: string; city_name?: string };
      duration: string; // ISO-8601 duration
      segments: Array<{
        departing_at: string;
        arriving_at: string;
        marketing_carrier: { iata_code: string };
        marketing_carrier_flight_number: string;
      }>;
    }>;
    expires_at?: string;
  }>;
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  const sym = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return sym ? `${sym}${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
}

function formatIsoDuration(iso: string): string {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  if (!m) return iso;
  const h = m[1] ? `${m[1]}h` : "";
  const mn = m[2] ? `${m[2]}m` : "";
  return [h, mn].filter(Boolean).join(" ") || iso;
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

export function FlightOffersSelectCard({
  payload,
  onSubmit,
  disabled,
  decidedLabel,
}: {
  payload: FlightOffersSelection;
  onSubmit: (text: string) => void;
  disabled?: boolean;
  decidedLabel?: "confirmed" | "cancelled" | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const frozen = !!decidedLabel || !!disabled;

  const submit = () => {
    if (!selectedId || frozen) return;
    const offer = payload.offers.find((o) => o.offer_id === selectedId);
    if (!offer) return;
    const firstSlice = offer.slices[0]!;
    const firstSeg = firstSlice.segments[0]!;
    const onward = firstSlice.segments.length > 1 ? " (with connection)" : " direct";
    onSubmit(
      `Go with offer ${offer.offer_id} — the ${formatTime(firstSeg.departing_at)} ${offer.owner.name}${onward} for ${formatMoney(offer.total_amount, offer.total_currency)}.`,
    );
  };

  if (!payload.offers?.length) return null;

  return (
    <div className="w-full max-w-[600px] animate-fade-up rounded-xl bg-lumo-surface border border-lumo-hair overflow-hidden">
      {/* Header — muted micro-label, neutral weight body */}
      <div className="px-4 pt-3.5 pb-3 border-b border-lumo-hair">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
          Flight options
        </div>
        <div className="mt-1 text-[14px] font-medium text-lumo-fg">
          {payload.offers.length} offer{payload.offers.length === 1 ? "" : "s"}{" "}
          <span className="text-lumo-fg-mid font-normal">· pick one</span>
        </div>
      </div>

      {/* Offer rows */}
      <ul
        className="divide-y divide-lumo-hair max-h-[480px] overflow-y-auto"
        role="radiogroup"
        aria-label="Flight offers"
      >
        {payload.offers.map((o) => {
          const selected = o.offer_id === selectedId;
          const firstSlice = o.slices[0]!;
          const firstSeg = firstSlice.segments[0]!;
          const lastSeg = firstSlice.segments[firstSlice.segments.length - 1]!;
          const stops = firstSlice.segments.length - 1;
          const flightNumbers = firstSlice.segments
            .map((s) => `${s.marketing_carrier.iata_code}${s.marketing_carrier_flight_number}`)
            .join(" · ");

          return (
            <li key={o.offer_id}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => !frozen && setSelectedId(o.offer_id)}
                disabled={frozen}
                className={`w-full text-left flex items-start gap-3 px-4 py-3.5 transition-colors relative ${
                  selected
                    ? "bg-lumo-elevated"
                    : "hover:bg-lumo-elevated/60"
                } disabled:opacity-70`}
              >
                {/* Selection indicator — thin accent bar on the left edge */}
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
                      selected
                        ? "border-lumo-accent"
                        : "border-lumo-edge"
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
                      {formatTime(firstSeg.departing_at)}
                    </span>
                    <span className="text-[11.5px] text-lumo-fg-mid font-mono">
                      {firstSlice.origin.iata_code}
                    </span>
                    <span className="text-lumo-fg-low">→</span>
                    <span className="text-[14px] font-medium text-lumo-fg num">
                      {formatTime(lastSeg.arriving_at)}
                    </span>
                    <span className="text-[11.5px] text-lumo-fg-mid font-mono">
                      {firstSlice.destination.iata_code}
                    </span>
                  </div>

                  <div className="text-[12px] text-lumo-fg-mid">
                    {formatDate(firstSeg.departing_at)} · {o.owner.name}{" "}
                    <span className="font-mono num">{flightNumbers}</span> ·{" "}
                    <span className="num">{formatIsoDuration(firstSlice.duration)}</span>
                    {stops === 0 ? " · nonstop" : ` · ${stops} stop${stops === 1 ? "" : "s"}`}
                  </div>
                </div>

                {/* Price */}
                <div className="shrink-0 text-right">
                  <div className="text-[14px] font-medium text-lumo-fg num">
                    {formatMoney(o.total_amount, o.total_currency)}
                  </div>
                  <div className="text-[10px] text-lumo-fg-low uppercase tracking-[0.1em] mt-0.5">
                    total
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Footer CTA */}
      <div className="border-t border-lumo-hair px-3 py-2.5">
        {decidedLabel === "confirmed" ? (
          <div className="text-[12px] text-lumo-ok text-center font-medium py-1">
            Selected · pricing up for confirmation
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
            {selectedId ? "Continue with this flight" : "Select a flight to continue"}
          </button>
        )}
      </div>
    </div>
  );
}
