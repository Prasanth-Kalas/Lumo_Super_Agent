"use client";

/**
 * ItineraryConfirmationCard
 *
 * Rendered in-thread when the orchestrator receives a
 * `structured-itinerary` summary frame from the shell. The payload
 * shape is the canonical summary the Flight Agent hashes (see
 * apps/flight-agent/lib/duffel-stub.ts :: canonicalItinerarySummary).
 * This component is display-only — it MUST NOT mutate or re-shape
 * the payload. The server may add display-only profile fields to the
 * payload; the summary hash remains the agent-authoritative itinerary
 * hash used by the shell's money gate.
 *
 * Confirm / Cancel fire callbacks the parent uses to send the next
 * user message. The parent is responsible for locking the card after
 * a decision; we surface `disabled` as the single lever for that.
 *
 * Visual system — Linear/Vercel dark-first, parity with
 * ReservationConfirmationCard so the two money-gate surfaces feel of
 * a piece.
 */
import { type FormEvent, useMemo, useState } from "react";

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
  traveler_summary?: string | null;
  payment_summary?: string | null;
  prefilled?: boolean;
  missing_fields?: string[];
}

export interface ItineraryConfirmationCardProps {
  payload: ItineraryPayload;
  onConfirm: () => void;
  onCancel: () => void;
  onDifferentTraveler?: () => void;
  onMissingFieldsSubmit?: (message: string) => void;
  /** Disable both buttons (busy / already decided). */
  disabled?: boolean;
  /** Optional deciding-state label shown in place of buttons. */
  decidedLabel?: "confirmed" | "cancelled" | null;
}

// Minimal IATA → city map. Display-only; hash stability doesn't
// depend on this being complete.
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

// NOTE: intentionally no `durationBetween` helper — Duffel returns
// TZ-naive timestamps and subtraction on the client produces wrong
// durations for cross-TZ flights. Duration is already on the radio
// card upstream.

export function ItineraryConfirmationCard({
  payload,
  onConfirm,
  onCancel,
  onDifferentTraveler,
  onMissingFieldsSubmit,
  disabled,
  decidedLabel,
}: ItineraryConfirmationCardProps) {
  const totalLabel = useMemo(
    () => formatMoney(payload.total_amount, payload.total_currency),
    [payload.total_amount, payload.total_currency],
  );
  const missingFields = useMemo(
    () => normalizeMissingFields(payload.missing_fields ?? []),
    [payload.missing_fields],
  );
  const [missingValues, setMissingValues] = useState<Record<string, string>>({});

  function submitMissingFields(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onMissingFieldsSubmit || disabled) return;
    const details = missingFields
      .map((field) => [field, (missingValues[field] ?? "").trim()] as const)
      .filter(([, value]) => value.length > 0)
      .map(([field, value]) => `${missingFieldLabel(field)}: ${value}`);
    if (details.length === 0) return;
    onMissingFieldsSubmit(`Here are the missing booking details: ${details.join("; ")}`);
  }

  return (
    <div
      role="group"
      aria-label="Flight booking confirmation"
      className="w-full max-w-[600px] rounded-xl border border-lumo-hair bg-lumo-surface overflow-hidden animate-fade-up"
    >
      {/* Header: trip route + total */}
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3.5 border-b border-lumo-hair">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
            Confirm booking
          </div>
          <div className="mt-1 text-[15px] font-semibold tracking-[-0.005em] text-lumo-fg truncate">
            {payload.slices
              .map((s) => `${cityFor(s.origin)} → ${cityFor(s.destination)}`)
              .join("  ·  ")}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
            Total
          </div>
          <div className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-lumo-fg num">
            {totalLabel}
          </div>
        </div>
      </div>

      {payload.traveler_summary || payload.payment_summary || missingFields.length > 0 ? (
        <div className="border-b border-lumo-hair px-5 py-3.5 space-y-3">
          {payload.prefilled ? (
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low font-medium">
              Prefilled from approved profile
            </div>
          ) : null}
          {payload.traveler_summary ? (
            <ProfileSummaryRow
              marker={initialFor(payload.traveler_summary)}
              label="Traveler"
              value={payload.traveler_summary}
            />
          ) : null}
          {payload.payment_summary ? (
            <ProfileSummaryRow
              marker="CARD"
              label="Payment"
              value={payload.payment_summary}
            />
          ) : null}
          {missingFields.length > 0 ? (
            <form
              onSubmit={submitMissingFields}
              className="rounded-lg border border-lumo-hair bg-lumo-inset px-3 py-3"
            >
              <div className="text-[11px] font-medium text-lumo-fg-mid">
                Need: {missingFields.map(missingFieldLabel).join(", ")}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {missingFields.map((field) => (
                  <label key={field} className="text-[11px] text-lumo-fg-low">
                    {missingFieldLabel(field)}
                    <input
                      type="text"
                      value={missingValues[field] ?? ""}
                      onChange={(event) =>
                        setMissingValues((prev) => ({
                          ...prev,
                          [field]: event.currentTarget.value,
                        }))
                      }
                      disabled={disabled}
                      placeholder={missingFieldPlaceholder(field)}
                      className="mt-1 h-8 w-full rounded-md border border-lumo-hair bg-lumo-bg px-2.5 text-[12.5px] text-lumo-fg outline-none transition-colors placeholder:text-lumo-fg-low focus:border-lumo-edge disabled:opacity-50"
                    />
                  </label>
                ))}
              </div>
              {onMissingFieldsSubmit ? (
                <button
                  type="submit"
                  disabled={
                    disabled ||
                    missingFields.every((field) => !(missingValues[field] ?? "").trim())
                  }
                  className="mt-2 h-8 rounded-md border border-lumo-hair px-3 text-[12px] font-medium text-lumo-fg-mid transition-colors hover:bg-lumo-elevated hover:text-lumo-fg disabled:opacity-40"
                >
                  Send details
                </button>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}

      {/* Slices & segments. One row per segment. */}
      <div className="px-5 py-4 divide-y divide-lumo-hair">
        {payload.slices.map((slice, si) => (
          <div key={si} className="py-3 first:pt-0 last:pb-0">
            {payload.slices.length > 1 && (
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium mb-2.5">
                {si === 0 ? "Outbound" : si === 1 ? "Return" : `Leg ${si + 1}`}
              </div>
            )}
            <ul className="space-y-2.5">
              {slice.segments.map((seg, gi) => (
                <li
                  key={gi}
                  className="grid grid-cols-[auto_1fr] items-center gap-3"
                >
                  {/* Carrier chip — mono letters on inset square */}
                  <div className="h-8 w-10 rounded-md bg-lumo-inset border border-lumo-hair flex items-center justify-center font-mono text-[10.5px] font-medium text-lumo-fg tracking-wider">
                    {seg.carrier}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] text-lumo-fg truncate">
                      <span className="font-medium font-mono num">
                        {seg.origin} → {seg.destination}
                      </span>
                      <span className="text-lumo-fg-mid font-normal">
                        {"  ·  "}
                        {carrierFor(seg.carrier)}{" "}
                        <span className="font-mono num">
                          {seg.carrier}
                          {seg.flight_number}
                        </span>
                      </span>
                    </div>
                    <div className="text-[12px] text-lumo-fg-mid mt-0.5 num">
                      {formatDate(seg.departing_at)}{" "}
                      <span className="text-lumo-fg-low">·</span>{" "}
                      {formatTime(seg.departing_at)}{" "}
                      <span className="text-lumo-fg-low">→</span>{" "}
                      {formatTime(seg.arriving_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-lumo-hair flex items-center justify-between gap-3">
        <div className="text-[11px] text-lumo-fg-low truncate">
          Offer{" "}
          <span className="font-mono text-lumo-fg-mid num">
            {payload.offer_id}
          </span>
        </div>
        {decidedLabel ? (
          <div
            className={`text-[12px] font-medium ${
              decidedLabel === "confirmed" ? "text-lumo-ok" : "text-lumo-fg-mid"
            }`}
            aria-live="polite"
          >
            {decidedLabel === "confirmed" ? "Confirmed — booking…" : "Cancelled"}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {onDifferentTraveler ? (
              <button
                type="button"
                onClick={onDifferentTraveler}
                disabled={disabled}
                className="h-8 px-3 rounded-md text-[12.5px] font-medium text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors disabled:opacity-40"
              >
                Different traveler
              </button>
            ) : null}
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
              Confirm booking
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileSummaryRow({
  marker,
  label,
  value,
}: {
  marker: string;
  label: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-3">
      <div className="flex h-8 min-w-8 items-center justify-center rounded-md border border-lumo-hair bg-lumo-elevated px-2 font-mono text-[10px] font-semibold text-lumo-fg-mid">
        {marker}
      </div>
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low font-medium">
          {label}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-lumo-fg">{value}</div>
      </div>
    </div>
  );
}

function normalizeMissingFields(fields: string[]): string[] {
  return Array.from(new Set(fields.map((field) => field.trim()).filter(Boolean)));
}

function missingFieldLabel(field: string): string {
  if (field === "payment_method_id") return "Payment method";
  if (field === "traveler_profile") return "Traveler profile";
  if (field === "passport_optional") return "Passport";
  if (field === "dob") return "Date of birth";
  return field
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function missingFieldPlaceholder(field: string): string {
  if (field === "payment_method_id") return "Default card or payment method";
  if (field === "traveler_profile") return "Traveler name and details";
  if (field === "email") return "traveler@example.com";
  if (field === "phone") return "+1 ...";
  if (field === "dob") return "YYYY-MM-DD";
  return "";
}

function initialFor(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "P";
}
