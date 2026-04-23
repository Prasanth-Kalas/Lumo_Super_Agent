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
 *   The selected row gets a bright accent ring and the primary CTA
 *   becomes active.
 * - Submitting emits a single natural-language turn back into the
 *   chat stream, carrying the exact `offer_id` so the orchestrator
 *   can forward it to `flight_price_offer` without ambiguity:
 *     "Go with offer off_0000B5aXPsQikldcXxRope — the 10:50 Iberia
 *      direct for $48.09."
 *   The offer_id is the precise handle; the narrative bit is just
 *   for the user's readable log.
 * - After the orchestrator prices the chosen offer, the existing
 *   `ItineraryConfirmationCard` takes over for the money-gate step.
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
  // "PT1H18M" → "1h 18m" · "PT45M" → "45m" · "PT2H" → "2h"
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  if (!m) return iso;
  const h = m[1] ? `${m[1]}h` : "";
  const mn = m[2] ? `${m[2]}m` : "";
  return [h, mn].filter(Boolean).join(" ") || iso;
}

function formatTime(iso: string): string {
  // "2026-05-15T10:50:00" → "10:50 AM" · "2026-05-15T00:00:00" → "12:00 AM"
  // Uses Intl so the radio card matches ItineraryConfirmationCard's
  // time format end-to-end (search → price → confirm). Falls back to
  // a regex slice if the ISO is unparseable.
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
  // "2026-05-15T10:50:00" → "Fri, May 15"
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
    <div className="mr-auto max-w-[92%] ml-[34px] animate-fade-up rounded-2xl bg-lumo-surface border border-lumo-hairline shadow-card overflow-hidden">
      {/* Header strip */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-lumo-hairline bg-gradient-to-r from-lumo-accent/8 to-transparent">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-lumo-muted font-semibold">
            Flight options — pick one
          </div>
          <div className="text-[15px] font-semibold text-lumo-ink">
            {payload.offers.length} offer{payload.offers.length === 1 ? "" : "s"} found
          </div>
        </div>
      </div>

      {/* Offer rows */}
      <ul
        className="divide-y divide-lumo-hairline max-h-[480px] overflow-y-auto"
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
                      {formatTime(firstSeg.departing_at)}
                    </span>
                    <span className="text-[12px] text-lumo-muted">
                      {firstSlice.origin.iata_code}
                    </span>
                    <span className="text-lumo-muted">→</span>
                    <span className="text-[15px] font-semibold text-lumo-ink tabular-nums">
                      {formatTime(lastSeg.arriving_at)}
                    </span>
                    <span className="text-[12px] text-lumo-muted">
                      {firstSlice.destination.iata_code}
                    </span>
                  </div>

                  <div className="text-[12.5px] text-lumo-muted">
                    {formatDate(firstSeg.departing_at)} · {o.owner.name} {flightNumbers} ·{" "}
                    {formatIsoDuration(firstSlice.duration)}
                    {stops === 0 ? " · nonstop" : ` · ${stops} stop${stops === 1 ? "" : "s"}`}
                  </div>
                </div>

                {/* Price */}
                <div className="shrink-0 text-right">
                  <div className="text-[15px] font-semibold text-lumo-ink tabular-nums">
                    {formatMoney(o.total_amount, o.total_currency)}
                  </div>
                  <div className="text-[10.5px] text-lumo-muted uppercase tracking-wider">
                    total
                  </div>
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
            Selected · pricing up for confirmation
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
            {selectedId ? "Continue with this flight" : "Select a flight to continue"}
          </button>
        )}
      </div>
    </div>
  );
}
