"use client";

/**
 * TripConfirmationCard
 *
 * Rendered in-thread when the orchestrator emits a `structured-trip`
 * summary frame — i.e. the user's ask spans multiple specialists and
 * we've assembled a compound TripSummary envelope. The card is the
 * single affirmation surface for every leg at once; the user hits
 * one Confirm and the shell dispatches bookings in dependency order.
 *
 * Shape of the payload mirrors @lumo/agent-sdk's TripSummaryPayload.
 * We re-declare the types locally so the client bundle does not pull
 * the SDK runtime (and transitively node:crypto) — same reason the
 * itinerary card inlines its payload types.
 *
 * Dual-mode rendering:
 *
 *   1. **Pre-confirm** — no legStatuses passed. Show per-leg preview
 *      rows with their money amounts, single trip total, Confirm/Cancel.
 *
 *   2. **Post-confirm / dispatching** — legStatuses map keyed by
 *      order is passed by the page. Each leg row swaps its money
 *      line for a status pill (pending / booking… / booked / failed /
 *      rolled back). Confirm/Cancel collapse to a dispatch-state
 *      label.
 *
 * Holding both modes in one component avoids the flicker and layout
 * shift you'd get swapping between two separate cards. The visual
 * container stays put; only the status column animates.
 *
 * Display-only. Never mutates the payload — the compound hash the
 * shell gate checks is computed over this exact object.
 *
 * Visual system — Linear/Vercel dark-first. Agent glyphs are
 * monoline SVG marks (no emoji) so the card reads as a professional
 * product surface, not a consumer app.
 */

import { useMemo, type ReactElement } from "react";

// ──────────────────────────────────────────────────────────────────
// Types — mirror @lumo/agent-sdk/src/trips.ts (client-bundle-safe)
// ──────────────────────────────────────────────────────────────────

/**
 * The per-leg kinds supported today. A TripLegRef.summary.kind is
 * one of these — each gets its own compact sub-renderer below.
 */
type LegSummaryKind =
  | "structured-itinerary" // flight agent
  | "structured-cart"      // food / restaurant agent
  | "structured-booking";  // hotel / generic booking agent

interface LegAttachedSummary {
  kind: LegSummaryKind;
  payload: unknown;
  hash: string;
}

export interface TripLegRef {
  agent_id: string;
  tool_name: string;
  summary: LegAttachedSummary;
  order: number;
  depends_on: number[];
}

export interface TripPayload {
  /** Always `"structured-trip"` — mirrors TripSummary.kind. */
  kind: "structured-trip";
  trip_title: string;
  total_amount: string; // decimal string
  currency: string;     // ISO 4217
  legs: TripLegRef[];
}

/**
 * Execution status for a leg. Matches
 * lib/trip-state.ts :: LegExecutionStatus.
 */
export type LegDispatchStatus =
  | "pending"
  | "in_flight"
  | "committed"
  | "failed"
  | "rolled_back"
  | "rollback_failed";

export interface TripConfirmationCardProps {
  payload: TripPayload;
  onConfirm: () => void;
  onCancel: () => void;
  /** Disable both buttons (busy / already decided). */
  disabled?: boolean;
  /** Optional deciding-state label shown in place of buttons. */
  decidedLabel?: "confirmed" | "cancelled" | null;
  /**
   * Per-leg dispatch status keyed by TripLegRef.order. Passing this
   * switches the card into dispatching/post-confirm mode.
   */
  legStatuses?: Record<number, LegDispatchStatus>;
}

// ──────────────────────────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────────────────────────

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

function formatMoneyPrecise(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
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

// ──────────────────────────────────────────────────────────────────
// Agent glyphs — monoline SVG marks, `currentColor` so they inherit
// the row's text color. No emoji anywhere.
// ──────────────────────────────────────────────────────────────────

function FlightGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 9.5l11-4.5-1.5 4L5 11l-1 2-1-1 1-2-1.5-.5z" />
    </svg>
  );
}

function FoodGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* Fork */}
      <path d="M5 2v4M5 6a2 2 0 0 0 2-2V2M5 6v8" />
      {/* Knife */}
      <path d="M11 2c1 2 1 4 0 6v6" />
    </svg>
  );
}

function HotelGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 14V5h12v9M2 9h12M5 9V6M8 9V6M11 9V6" />
    </svg>
  );
}

function CarGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 10V8l1.5-3h8l1.5 3v2M2.5 10v2M13.5 10v2M2.5 10h11" />
      <circle cx="5" cy="12" r="1" />
      <circle cx="11" cy="12" r="1" />
    </svg>
  );
}

function DotGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
    </svg>
  );
}

function agentLabel(agent_id: string): {
  short: string;
  Glyph: () => ReactElement;
} {
  const id = agent_id.toLowerCase();
  if (id.includes("flight")) return { short: "Flight", Glyph: FlightGlyph };
  if (id.includes("food") || id.includes("restaurant"))
    return { short: "Food", Glyph: FoodGlyph };
  if (id.includes("hotel") || id.includes("stay"))
    return { short: "Hotel", Glyph: HotelGlyph };
  if (id.includes("car") || id.includes("ride"))
    return { short: "Car", Glyph: CarGlyph };
  return { short: agent_id, Glyph: DotGlyph };
}

// ──────────────────────────────────────────────────────────────────
// Per-leg sub-renderers — one per summary kind
// ──────────────────────────────────────────────────────────────────

function FlightLegRow({ payload }: { payload: unknown }) {
  const p = payload as {
    slices?: Array<{
      origin: string;
      destination: string;
      segments?: Array<{ departing_at?: string }>;
    }>;
  };
  const slices = Array.isArray(p?.slices) ? p.slices : [];
  if (slices.length === 0) {
    return <div className="text-[13px] text-lumo-fg-mid">Flight</div>;
  }
  const first = slices[0]!;
  const last = slices[slices.length - 1]!;
  const firstDep = first.segments?.[0]?.departing_at;
  const route =
    slices.length > 1
      ? `${first.origin} → ${first.destination} · ${last.origin} → ${last.destination}`
      : `${first.origin} → ${first.destination}`;
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-lumo-fg truncate font-mono num">
        {route}
      </div>
      <div className="text-[11.5px] text-lumo-fg-mid mt-0.5 num">
        {firstDep
          ? `${formatDate(firstDep)} · ${formatTime(firstDep)}`
          : `${slices.length} flight${slices.length > 1 ? "s" : ""}`}
      </div>
    </div>
  );
}

function CartLegRow({ payload }: { payload: unknown }) {
  const p = payload as {
    merchant_name?: string;
    restaurant_name?: string;
    items?: Array<{ name?: string; quantity?: number }>;
  };
  const merchant = p?.merchant_name ?? p?.restaurant_name ?? "Food order";
  const items = Array.isArray(p?.items) ? p.items : [];
  const itemCount = items.reduce(
    (sum, it) => sum + (Number.isFinite(it?.quantity) ? (it.quantity as number) : 1),
    0,
  );
  const preview = items
    .slice(0, 2)
    .map((it) => it?.name)
    .filter((n): n is string => typeof n === "string")
    .join(", ");
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-lumo-fg truncate">
        {merchant}
      </div>
      <div className="text-[11.5px] text-lumo-fg-mid mt-0.5 truncate">
        {itemCount > 0 ? (
          <>
            <span className="num">{itemCount}</span>{" "}
            item{itemCount === 1 ? "" : "s"}
          </>
        ) : (
          "Order"
        )}
        {preview ? ` · ${preview}` : ""}
      </div>
    </div>
  );
}

function BookingLegRow({ payload }: { payload: unknown }) {
  const p = payload as {
    hotel_name?: string;
    property_name?: string;
    title?: string;
    check_in?: string;
    check_out?: string;
    starts_at?: string;
    ends_at?: string;
  };
  const title = p?.hotel_name ?? p?.property_name ?? p?.title ?? "Booking";
  const from = p?.check_in ?? p?.starts_at;
  const to = p?.check_out ?? p?.ends_at;
  const when =
    from && to
      ? `${formatDate(from)} → ${formatDate(to)}`
      : from
      ? formatDate(from)
      : null;
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-lumo-fg truncate">
        {title}
      </div>
      {when ? (
        <div className="text-[11.5px] text-lumo-fg-mid mt-0.5 truncate num">
          {when}
        </div>
      ) : null}
    </div>
  );
}

function GenericLegRow({ toolName }: { toolName: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-lumo-fg truncate font-mono">
        {toolName}
      </div>
      <div className="text-[11.5px] text-lumo-fg-mid mt-0.5">Booking</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Status pill — maps LegDispatchStatus to a short label + classes
// ──────────────────────────────────────────────────────────────────

function statusPill(status: LegDispatchStatus): {
  label: string;
  className: string;
  ariaLive: "off" | "polite";
} {
  switch (status) {
    case "pending":
      return {
        label: "Pending",
        className: "bg-lumo-inset text-lumo-fg-low border-lumo-hair",
        ariaLive: "off",
      };
    case "in_flight":
      return {
        label: "Booking…",
        className: "bg-lumo-inset text-lumo-fg border-lumo-edge",
        ariaLive: "polite",
      };
    case "committed":
      return {
        label: "Booked",
        className: "bg-lumo-inset text-lumo-ok border-lumo-hair",
        ariaLive: "polite",
      };
    case "failed":
      return {
        label: "Failed",
        className: "bg-lumo-inset text-lumo-err border-lumo-hair",
        ariaLive: "polite",
      };
    case "rolled_back":
      return {
        label: "Rolled back",
        className: "bg-lumo-inset text-lumo-warn border-lumo-hair",
        ariaLive: "polite",
      };
    case "rollback_failed":
      return {
        label: "Rollback failed",
        className: "bg-lumo-inset text-lumo-err border-lumo-edge",
        ariaLive: "polite",
      };
  }
}

/** Aggregate state across all legs — drives the footer banner. */
function aggregateState(
  legs: TripLegRef[],
  statuses: Record<number, LegDispatchStatus>,
): "idle" | "dispatching" | "committed" | "partial_failure" | "rolled_back" {
  const vals = legs.map((l) => statuses[l.order] ?? "pending");
  if (vals.every((v) => v === "committed")) return "committed";
  if (vals.every((v) => v === "rolled_back")) return "rolled_back";
  if (vals.some((v) => v === "rollback_failed" || v === "failed"))
    return "partial_failure";
  if (vals.some((v) => v === "in_flight" || v === "committed"))
    return "dispatching";
  return "idle";
}

// ──────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────

export function TripConfirmationCard({
  payload,
  onConfirm,
  onCancel,
  disabled,
  decidedLabel,
  legStatuses,
}: TripConfirmationCardProps) {
  const totalLabel = useMemo(
    () => formatMoney(payload.total_amount, payload.currency),
    [payload.total_amount, payload.currency],
  );

  const sortedLegs = useMemo(
    () => payload.legs.slice().sort((a, b) => a.order - b.order),
    [payload.legs],
  );

  const dispatching = Boolean(legStatuses);
  const agg =
    dispatching && legStatuses
      ? aggregateState(sortedLegs, legStatuses)
      : "idle";

  return (
    <div
      role="group"
      aria-label="Trip booking confirmation"
      className="w-full max-w-[600px] rounded-xl border border-lumo-hair bg-lumo-surface overflow-hidden animate-fade-up"
    >
      {/* Header: trip title + total */}
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3.5 border-b border-lumo-hair">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
            {dispatching ? "Trip in progress" : "Confirm trip"}
          </div>
          <div className="mt-1 text-[15px] font-semibold tracking-[-0.005em] text-lumo-fg truncate">
            {payload.trip_title}
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

      {/* Per-leg rows */}
      <div className="px-5 py-2 divide-y divide-lumo-hair">
        {sortedLegs.map((leg) => {
          const agent = agentLabel(leg.agent_id);
          const status = legStatuses?.[leg.order];
          const legMoney = (leg.summary.payload as { total_amount?: string })
            ?.total_amount;
          const legCurrency =
            (leg.summary.payload as { total_currency?: string; currency?: string })
              ?.total_currency ??
            (leg.summary.payload as { currency?: string })?.currency ??
            payload.currency;

          return (
            <div
              key={leg.order}
              className="py-3 grid grid-cols-[auto_1fr_auto] items-center gap-3"
            >
              {/* Left: agent glyph + label */}
              <div className="flex items-center gap-2 w-[92px] shrink-0">
                <div className="h-7 w-7 rounded-md border border-lumo-hair bg-lumo-inset flex items-center justify-center text-lumo-fg-mid">
                  <agent.Glyph />
                </div>
                <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
                  {agent.short}
                </div>
              </div>

              {/* Middle: summary-kind-aware body */}
              {leg.summary.kind === "structured-itinerary" ? (
                <FlightLegRow payload={leg.summary.payload} />
              ) : leg.summary.kind === "structured-cart" ? (
                <CartLegRow payload={leg.summary.payload} />
              ) : leg.summary.kind === "structured-booking" ? (
                <BookingLegRow payload={leg.summary.payload} />
              ) : (
                <GenericLegRow toolName={leg.tool_name} />
              )}

              {/* Right: money or dispatch pill */}
              <div className="text-right shrink-0">
                {status ? (
                  (() => {
                    const pill = statusPill(status);
                    return (
                      <span
                        className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-md border ${pill.className}`}
                        aria-live={pill.ariaLive}
                      >
                        {status === "in_flight" ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-current animate-dot-1" />
                        ) : null}
                        {pill.label}
                      </span>
                    );
                  })()
                ) : legMoney ? (
                  <div className="text-[13px] text-lumo-fg num">
                    {formatMoneyPrecise(legMoney, legCurrency)}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer — three variants:
          1. dispatch-mode: aggregate status banner
          2. decidedLabel set: frozen "Confirmed — booking…" line
          3. otherwise: Cancel / Confirm trip */}
      <div className="px-5 py-3 border-t border-lumo-hair flex items-center justify-between gap-3">
        <div className="text-[11px] text-lumo-fg-low truncate">
          <span className="num">{payload.legs.length}</span> leg
          {payload.legs.length === 1 ? "" : "s"}
          {dispatching ? null : " · one confirmation covers all"}
        </div>

        {dispatching ? (
          <DispatchFooter agg={agg} />
        ) : decidedLabel ? (
          <div
            className={`text-[12px] font-medium ${
              decidedLabel === "confirmed" ? "text-lumo-ok" : "text-lumo-fg-mid"
            }`}
            aria-live="polite"
          >
            {decidedLabel === "confirmed"
              ? "Confirmed — booking your trip…"
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
              Confirm trip
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Footer banner while a trip is dispatching. Picks a single phrase
 * that maps to the aggregate; per-leg details are already inline.
 */
function DispatchFooter({
  agg,
}: {
  agg: "idle" | "dispatching" | "committed" | "partial_failure" | "rolled_back";
}) {
  if (agg === "committed") {
    return (
      <div
        className="text-[12px] font-medium text-lumo-ok inline-flex items-center gap-1.5"
        aria-live="polite"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-lumo-ok" aria-hidden />
        All legs booked
      </div>
    );
  }
  if (agg === "rolled_back") {
    return (
      <div
        className="text-[12px] font-medium text-lumo-warn"
        aria-live="polite"
      >
        Rolled back — you haven't been charged
      </div>
    );
  }
  if (agg === "partial_failure") {
    return (
      <div className="text-[12px] font-medium text-lumo-err" aria-live="polite">
        Something failed — checking what's recoverable
      </div>
    );
  }
  return (
    <div
      className="text-[12px] font-medium text-lumo-fg inline-flex items-center gap-1.5"
      aria-live="polite"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-lumo-accent animate-dot-1" aria-hidden />
      Dispatching…
    </div>
  );
}
