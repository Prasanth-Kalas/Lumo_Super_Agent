"use client";

/**
 * TripConfirmationCard
 *
 * Rendered in-thread when the orchestrator emits a `structured-trip`
 * summary frame — i.e. the user's ask spans multiple specialists and
 * we've assembled a compound TripSummary envelope. The card is the
 * single affirmation surface for every leg at once; the user hits one
 * Confirm and the shell dispatches bookings in dependency order.
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
 *   2. **Post-confirm / dispatching** — legStatuses map keyed by order
 *      is passed by the page. Each leg row swaps its money line for a
 *      status pill (pending • booking… • booked • failed • rolled back).
 *      Confirm/Cancel collapse to a dispatch-state label.
 *
 * Holding both modes in one component avoids the flicker and layout
 * shift you'd get swapping between two separate cards. The visual
 * container stays put; only the status column animates.
 *
 * Display-only. Never mutates the payload — the compound hash the shell
 * gate checks is computed over this exact object.
 */

import { useMemo } from "react";

// ──────────────────────────────────────────────────────────────────────────
// Types — mirror @lumo/agent-sdk/src/trips.ts (client-bundle-safe)
// ──────────────────────────────────────────────────────────────────────────

/**
 * The per-leg kinds supported today. A TripLegRef.summary.kind is one of
 * these — each gets its own compact sub-renderer below. Anything else
 * falls back to a generic "booking" row with just total + tool name.
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
 * lib/trip-state.ts :: LegExecutionStatus — kept as a string union here
 * so the card stays free of the server-side state module.
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
   * switches the card into dispatching/post-confirm mode (status pills
   * per leg, footer shows aggregate state). Omit for pre-confirm.
   */
  legStatuses?: Record<number, LegDispatchStatus>;
}

// ──────────────────────────────────────────────────────────────────────────
// Small formatters — same set the itinerary card uses, kept local so the
// two components stay independently deployable if we later split bundles.
// ──────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────
// Per-leg sub-renderers — one per summary kind
// ──────────────────────────────────────────────────────────────────────────

/**
 * Flight leg: show first/last airport in the trip's slices plus the
 * outbound date. Keeps the summary card dense; the full itinerary is
 * already visible in the itinerary card if the user asked for it, or
 * can be expanded on click (later PR).
 */
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
    return <div className="text-sm text-lumo-muted">Flight</div>;
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
      <div className="text-sm font-medium text-lumo-ink truncate">{route}</div>
      <div className="text-xs text-lumo-muted mt-0.5">
        {firstDep
          ? `${formatDate(firstDep)} · ${formatTime(firstDep)}`
          : `${slices.length} flight${slices.length > 1 ? "s" : ""}`}
      </div>
    </div>
  );
}

/**
 * Cart leg (food / restaurant): show merchant name + item count. We
 * don't assume a rigid cart schema across food vs. restaurant — just
 * look for common fields and fall back gracefully.
 */
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
      <div className="text-sm font-medium text-lumo-ink truncate">{merchant}</div>
      <div className="text-xs text-lumo-muted mt-0.5 truncate">
        {itemCount > 0 ? `${itemCount} item${itemCount === 1 ? "" : "s"}` : "Order"}
        {preview ? ` · ${preview}` : ""}
      </div>
    </div>
  );
}

/**
 * Generic booking leg (hotel / car / etc). Probe common field names —
 * hotel_name/check_in/check_out, property_name, etc — but stay generic.
 */
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
      <div className="text-sm font-medium text-lumo-ink truncate">{title}</div>
      {when ? (
        <div className="text-xs text-lumo-muted mt-0.5 truncate">{when}</div>
      ) : null}
    </div>
  );
}

/** Last-resort row for unknown kinds — show tool_name as the label. */
function GenericLegRow({ toolName }: { toolName: string }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-lumo-ink truncate">{toolName}</div>
      <div className="text-xs text-lumo-muted mt-0.5">Booking</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Leg classification → icon + agent label. Driven off agent_id rather
// than summary.kind because the user reads "Flight" / "Food" not
// "structured-itinerary".
// ──────────────────────────────────────────────────────────────────────────

function agentLabel(agent_id: string): { short: string; icon: string } {
  const id = agent_id.toLowerCase();
  if (id.includes("flight")) return { short: "Flight", icon: "✈" };
  if (id.includes("food") || id.includes("restaurant"))
    return { short: "Food", icon: "🍽" };
  if (id.includes("hotel") || id.includes("stay"))
    return { short: "Hotel", icon: "🏨" };
  if (id.includes("car") || id.includes("ride"))
    return { short: "Car", icon: "🚗" };
  return { short: agent_id, icon: "•" };
}

// ──────────────────────────────────────────────────────────────────────────
// Status pill — maps LegDispatchStatus to a short label + color class
// ──────────────────────────────────────────────────────────────────────────

function statusPill(status: LegDispatchStatus): {
  label: string;
  className: string;
  ariaLive: "off" | "polite";
} {
  switch (status) {
    case "pending":
      return {
        label: "Pending",
        className: "bg-lumo-paper text-lumo-muted",
        ariaLive: "off",
      };
    case "in_flight":
      return {
        label: "Booking…",
        className: "bg-lumo-accent/10 text-lumo-ink",
        ariaLive: "polite",
      };
    case "committed":
      return {
        label: "Booked",
        className: "bg-emerald-50 text-emerald-700",
        ariaLive: "polite",
      };
    case "failed":
      return {
        label: "Failed",
        className: "bg-red-50 text-red-700",
        ariaLive: "polite",
      };
    case "rolled_back":
      return {
        label: "Rolled back",
        className: "bg-amber-50 text-amber-700",
        ariaLive: "polite",
      };
    case "rollback_failed":
      return {
        label: "Rollback failed",
        className: "bg-red-100 text-red-800",
        ariaLive: "polite",
      };
  }
}

/** Aggregate state across all legs — drives the footer banner in dispatch mode. */
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

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────

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
      className="mr-auto max-w-[92%] w-full rounded-2xl border border-black/10 bg-white shadow-sm overflow-hidden"
    >
      {/* Header: the big, obvious trip name + total. Parallels the
          itinerary card's header so the two feel of a piece. */}
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-widest text-lumo-muted">
            {dispatching ? "Trip in progress" : "Confirm trip"}
          </div>
          <div className="text-base font-semibold tracking-tight text-lumo-ink truncate">
            {payload.trip_title}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] uppercase tracking-widest text-lumo-muted">Total</div>
          <div className="text-2xl font-semibold tracking-tight text-lumo-ink">
            {totalLabel}
          </div>
        </div>
      </div>

      {/* Per-leg rows. Visual rhythm matches the itinerary card — same
          left icon + two-line body + right column. */}
      <div className="px-5 py-3 divide-y divide-black/5">
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
              className="py-3 first:pt-0 last:pb-0 grid grid-cols-[auto_1fr_auto] items-center gap-3"
            >
              {/* Left: agent icon + short label stacked */}
              <div className="flex flex-col items-center gap-0.5 w-10">
                <div className="h-8 w-8 rounded-full bg-lumo-paper flex items-center justify-center text-base">
                  <span aria-hidden>{agent.icon}</span>
                </div>
                <div className="text-[10px] uppercase tracking-wider text-lumo-muted">
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
                        className={`inline-block text-[11px] font-medium px-2 py-1 rounded-full ${pill.className}`}
                        aria-live={pill.ariaLive}
                      >
                        {pill.label}
                      </span>
                    );
                  })()
                ) : legMoney ? (
                  <div className="text-sm text-lumo-ink tabular-nums">
                    {formatMoneyPrecise(legMoney, legCurrency)}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer — three variants:
          1. dispatch-mode: aggregate status banner, no buttons
          2. decidedLabel set: frozen "Confirmed — booking…" line
          3. otherwise: Cancel / Confirm trip */}
      <div className="px-5 py-3 border-t border-black/5 bg-lumo-paper/40 flex items-center justify-between gap-3">
        <div className="text-[11px] text-lumo-muted truncate">
          {payload.legs.length} leg{payload.legs.length === 1 ? "" : "s"}
          {dispatching ? null : " · one confirmation covers all"}
        </div>

        {dispatching ? (
          <DispatchFooter agg={agg} />
        ) : decidedLabel ? (
          <div
            className={`text-xs font-medium ${
              decidedLabel === "confirmed" ? "text-lumo-ink" : "text-lumo-muted"
            }`}
            aria-live="polite"
          >
            {decidedLabel === "confirmed"
              ? "Confirmed — booking your trip…"
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
              Confirm trip
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Footer banner while a trip is dispatching. Purely visual — the real
 * state lives in lib/trip-state.ts. We pick a single phrase that maps
 * to the aggregate and stay out of per-leg details; those are already
 * shown inline in the rows above.
 */
function DispatchFooter({
  agg,
}: {
  agg: "idle" | "dispatching" | "committed" | "partial_failure" | "rolled_back";
}) {
  if (agg === "committed") {
    return (
      <div className="text-xs font-medium text-emerald-700" aria-live="polite">
        All legs booked
      </div>
    );
  }
  if (agg === "rolled_back") {
    return (
      <div className="text-xs font-medium text-amber-700" aria-live="polite">
        Rolled back — you haven't been charged
      </div>
    );
  }
  if (agg === "partial_failure") {
    return (
      <div className="text-xs font-medium text-red-700" aria-live="polite">
        Something failed — checking what's recoverable
      </div>
    );
  }
  return (
    <div className="text-xs font-medium text-lumo-ink" aria-live="polite">
      Dispatching…
    </div>
  );
}
