"use client";

/**
 * FlightOffersSelectCard
 *
 * Single-select offers card rendered inline in the Super Agent chat
 * when the orchestrator calls `flight_search_offers`. Each row shows
 * one Duffel-shaped offer: carrier + flight numbers, depart → arrive,
 * duration, stop-count, and price on the right.
 *
 * Interaction model (CHAT-FLIGHT-SELECT-CLICKABLE-1)
 * ──────────────────────────────────────────────────
 * - Each row is a button. Tap → row shows a transient "Selected"
 *   pill, sibling rows fade to 40% opacity, then after a brief
 *   confirmation window the card submits the selection back into the
 *   chat stream — a single natural-language turn carrying the exact
 *   `offer_id` so the orchestrator can forward it to
 *   `flight_price_offer` without ambiguity.
 * - Keyboard: each row is a focusable button, Enter / Space triggers
 *   the same submit-on-tap path. Tab walks the offers in DOM order.
 * - Typing the carrier name in the chat composer ("frontier") still
 *   works as a power-user fallback — the orchestrator parses it
 *   server-side; this card doesn't gate that path.
 *
 * Prior to this lane the card had a separate "Continue with this
 * flight" CTA that committed a previously-set radio selection. The
 * two-step flow is gone — taps now commit directly. That removes a
 * dead-end: we observed users typing the carrier name in production
 * because the row click only highlighted the row without submitting.
 */

import { useEffect, useState } from "react";
import {
  buildOfferSubmitText,
  formatMoney,
  formatTime,
} from "@/lib/flight-offers-helpers";

export { buildOfferSubmitText };

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

function formatIsoDuration(iso: string): string {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  if (!m) return iso;
  const h = m[1] ? `${m[1]}h` : "";
  const mn = m[2] ? `${m[2]}m` : "";
  return [h, mn].filter(Boolean).join(" ") || iso;
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

/**
 * Window between visual "Selected" feedback and actual submit.
 * Long enough to be perceptible (so the user sees the row commit
 * before the chat advances), short enough to feel responsive.
 */
const SUBMIT_DELAY_MS = 280;

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
  // selectedId tracks "the user committed to this row" — no longer
  // a transient radio state. Once set, sibling rows dim and a brief
  // pill window plays before onSubmit fires.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const frozen = !!decidedLabel || !!disabled || selectedId !== null;

  // Fire the submit cascade after the visual confirmation window so
  // the user sees the row's "Selected" state before the chat
  // advances. If the component unmounts mid-window (e.g. because
  // sendText replaces the assistant message), the timeout is
  // cleaned up — no dangling onSubmit calls.
  useEffect(() => {
    if (!selectedId) return;
    const offer = payload.offers.find((o) => o.offer_id === selectedId);
    if (!offer) return;
    const handle = window.setTimeout(() => {
      onSubmit(buildOfferSubmitText(offer));
    }, SUBMIT_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [selectedId, payload.offers, onSubmit]);

  if (!payload.offers?.length) return null;

  const handlePick = (offerId: string) => {
    if (frozen) return;
    setSelectedId(offerId);
  };

  return (
    <div
      className="w-full max-w-[600px] animate-fade-up rounded-xl bg-lumo-surface border border-lumo-hair overflow-hidden"
      data-testid="flight-offers-card"
    >
      {/* Header — muted micro-label, neutral weight body */}
      <div className="px-4 pt-3.5 pb-3 border-b border-lumo-hair">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
          Flight options
        </div>
        <div className="mt-1 text-[14px] font-medium text-lumo-fg">
          {payload.offers.length} offer{payload.offers.length === 1 ? "" : "s"}{" "}
          <span className="text-lumo-fg-mid font-normal">· tap to select</span>
        </div>
      </div>

      {/* Offer rows */}
      <ul
        className="divide-y divide-lumo-hair max-h-[480px] overflow-y-auto"
        aria-label="Flight offers"
      >
        {payload.offers.map((o) => {
          const selected = o.offer_id === selectedId;
          const dimmed = selectedId !== null && !selected;
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
                onClick={() => handlePick(o.offer_id)}
                disabled={frozen && !selected}
                aria-pressed={selected}
                data-testid={`flight-offers-row-${o.offer_id}`}
                data-selected={selected ? "true" : "false"}
                data-dimmed={dimmed ? "true" : "false"}
                className={`w-full text-left flex items-start gap-3 px-4 py-3.5 transition-all relative focus:outline-none focus-visible:bg-lumo-elevated/80 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-lumo-accent ${
                  selected
                    ? "bg-lumo-elevated"
                    : "hover:bg-lumo-elevated/60"
                } ${dimmed ? "opacity-40" : "opacity-100"}`}
              >
                {/* Selection indicator — thin accent bar on the left edge */}
                <span
                  aria-hidden
                  className={`absolute left-0 top-0 bottom-0 w-[2px] transition-colors ${
                    selected ? "bg-lumo-accent" : "bg-transparent"
                  }`}
                />

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
                    {selected ? (
                      <span
                        className="ml-auto inline-flex items-center gap-1 rounded-full bg-lumo-accent/15 text-lumo-accent text-[10.5px] font-medium uppercase tracking-[0.1em] px-2 py-0.5"
                        data-testid={`flight-offers-row-${o.offer_id}-pill`}
                      >
                        <span className="block h-1.5 w-1.5 rounded-full bg-lumo-accent" />
                        Selected
                      </span>
                    ) : null}
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

      {/* Footer status — committed/cancelled labels only. The
          previous "Continue with this flight" CTA is gone; tapping
          a row now commits directly via the SUBMIT_DELAY_MS window
          above. */}
      {decidedLabel === "confirmed" ? (
        <div className="border-t border-lumo-hair px-3 py-2.5 text-[12px] text-lumo-ok text-center font-medium">
          Selected · pricing up for confirmation
        </div>
      ) : decidedLabel === "cancelled" ? (
        <div className="border-t border-lumo-hair px-3 py-2.5 text-[12px] text-lumo-fg-mid text-center">
          Cancelled
        </div>
      ) : null}
    </div>
  );
}
