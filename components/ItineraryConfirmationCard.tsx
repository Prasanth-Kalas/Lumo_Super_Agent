"use client";

/**
 * ItineraryConfirmationCard
 *
 * Rendered in-thread when the orchestrator receives a `structured-itinerary`
 * summary frame from the shell. The payload shape is the canonical
 * summary the Flight Agent hashes (see
 * apps/flight-agent/lib/duffel-stub.ts :: canonicalItinerarySummary).
 * This component is display-only — it MUST NOT mutate or re-shape the
 * payload, or the hash check in the shell will fail.
 *
 * Confirm / Cancel fire callbacks the parent uses to send the next user
 * message. The parent is responsible for locking the card after a
 * decision; we surface `disabled` as the single lever for that.
 */
import { useMemo } from "react";

export interface ItinerarySegment {
  origin: string; // IATA
  destination: string; // IATA
  departing_at: string; // ISO 8601
  arriving_at: string; // ISO 8601
  carrier: string; // IATA ("UA")
  flight_number: string;
}

export interface ItinerarySlice {
  origin: string;
  destination: string;
  segments: ItinerarySegment[];
}

export interface ItineraryPayload {
  kind: "structured-itinerary";
  offer_id: string;
  total_amount: string; // decimal string from agent ("287.00")
  total_currency: string; // ISO 4217
  slices: ItinerarySlice[];
}

export interface ItineraryConfirmationCardProps {
  payload: ItineraryPayload;
  onConfirm: () => void;
  onCancel: () => void;
  /** Disable both buttons (busy / already decided). */
  disabled?: boolean;
  /** Optional deciding-state label shown in place of buttons. */
  decidedLabel?: "confirmed" | "cancelled" | null;
}

// Minimal IATA → city name map. Used only for display — no behavior
// depends on the mapping, so it's fine to be incomplete. Agents could
// later surface city_name in the canonical payload, but keeping the
// payload minimal preserves hash stability.
const CITY_BY_IATA: Record<string, string> = {
  SFO: "San Francisco",
  LAS: "Las Vegas",
  JFK: "New York",
  LAX: "Los Angeles",
  SEA: "Seattle",
  ORD: "Chicago",
  LHR: "London",
  NRT: "Tokyo",
  SJC: "San Jose",
  BOS: "Boston",
  AUS: "Austin",
  DEN: "Denver",
};

const CARRIER_NAMES: Record<string, string> = {
  UA: "United",
  AS: "Alaska",
  DL: "Delta",
  AA: "American",
  BA: "British Airways",
  B6: "JetBlue",
};

function cityFor(iata: string): string {
  return CITY_BY_IATA[iata] ?? iata;
}

function carrierFor(iata: string): string {
  return CARRIER_NAMES[iata] ?? iata;
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0, // airfare rounds to dollar for header display
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

// NOTE: intentionally no `durationBetween` helper here. Duffel returns
// TZ-naive ISO timestamps, so subtracting `new Date(a) - new Date(b)` on
// the client produces wildly wrong durations for cross-TZ flights (a
// 3h 49m ORD→LAS flight rendered as "1h 49m"). Duration is already
// visible on the preceding radio card (which uses Duffel's ISO-8601
// `duration` field directly) and in the assistant's lead-in text, so we
// omit it here rather than risk a misleading number on the money-gate
// screen. If/when the canonical summary payload grows a `duration_iso`
// field per segment (append-only, hash-compatible), we can surface it.

export function ItineraryConfirmationCard({
  payload,
  onConfirm,
  onCancel,
  disabled,
  decidedLabel,
}: ItineraryConfirmationCardProps) {
  const totalLabel = useMemo(
    () => formatMoney(payload.total_amount, payload.total_currency),
    [payload.total_amount, payload.total_currency],
  );

  return (
    <div
      role="group"
      aria-label="Flight booking confirmation"
      className="mr-auto max-w-[92%] w-full rounded-2xl border border-black/10 bg-white shadow-sm overflow-hidden"
    >
      {/* Header: the big, obvious "what you're about to pay" bar. */}
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-2">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-lumo-muted">
            Confirm booking
          </div>
          <div className="text-base font-semibold tracking-tight text-lumo-ink">
            {payload.slices
              .map((s) => `${cityFor(s.origin)} → ${cityFor(s.destination)}`)
              .join("  ·  ")}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-widest text-lumo-muted">Total</div>
          <div className="text-2xl font-semibold tracking-tight text-lumo-ink">
            {totalLabel}
          </div>
        </div>
      </div>

      {/* Slices & segments. One row per segment — same density as a real OTA. */}
      <div className="px-5 py-3 divide-y divide-black/5">
        {payload.slices.map((slice, si) => (
          <div key={si} className="py-3 first:pt-0 last:pb-0">
            {payload.slices.length > 1 && (
              <div className="text-[11px] uppercase tracking-widest text-lumo-muted mb-2">
                {si === 0 ? "Outbound" : si === 1 ? "Return" : `Leg ${si + 1}`}
              </div>
            )}
            <ul className="space-y-2">
              {slice.segments.map((seg, gi) => (
                <li
                  key={gi}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-3"
                >
                  <div className="h-8 w-8 rounded-full bg-lumo-paper flex items-center justify-center text-[11px] font-semibold text-lumo-ink">
                    {seg.carrier}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-lumo-ink truncate">
                      <span className="font-medium">
                        {seg.origin} → {seg.destination}
                      </span>
                      <span className="text-lumo-muted">
                        {"  ·  "}
                        {carrierFor(seg.carrier)} {seg.carrier}
                        {seg.flight_number}
                      </span>
                    </div>
                    <div className="text-xs text-lumo-muted mt-0.5">
                      {formatDate(seg.departing_at)} · {formatTime(seg.departing_at)} →{" "}
                      {formatTime(seg.arriving_at)}
                    </div>
                  </div>
                  <div className="text-xs text-lumo-muted tabular-nums">
                    {/* Reserved for seat/fare class in a later PR. */}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Footer: Cancel / Confirm OR a frozen-state label once decided. */}
      <div className="px-5 py-3 border-t border-black/5 bg-lumo-paper/40 flex items-center justify-between gap-3">
        <div className="text-[11px] text-lumo-muted truncate">
          Offer <span className="font-mono">{payload.offer_id}</span>
        </div>
        {decidedLabel ? (
          <div
            className={`text-xs font-medium ${
              decidedLabel === "confirmed" ? "text-lumo-ink" : "text-lumo-muted"
            }`}
            aria-live="polite"
          >
            {decidedLabel === "confirmed" ? "Confirmed — booking…" : "Cancelled"}
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
              Confirm booking
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
