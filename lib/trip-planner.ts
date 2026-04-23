/**
 * Trip planner — TripSummary assembly.
 *
 * The orchestrator prices each leg by calling the specialist's pricing
 * tool (e.g. `flight_price_offer`, `hotel_price_room`). Each tool result
 * carries a v0.1 `_lumo_summary` envelope PLUS raw domain fields
 * (total_amount, currency, etc.). This module takes those per-leg
 * priced results and assembles them into a single canonical
 * `TripSummaryPayload` the SDK's `attachTripSummary()` will then wrap
 * with a compound hash.
 *
 * Why a separate module rather than inlining into the orchestrator?
 *
 *   1. **Purity.** Assembly is deterministic — same inputs, same output.
 *      That property is worth preserving in isolation so we can fixture-
 *      test it without standing up Claude, the registry, or any specialist.
 *
 *   2. **Cross-leg validation lives here, not in the SDK.** The SDK's
 *      `assertValidTripPayload` validates the *shape* of a payload
 *      (ordering, DAG edges, leg hash shape). It deliberately does NOT
 *      check that leg amounts sum to total_amount or that every leg's
 *      currency matches the trip's currency, because the SDK doesn't
 *      know where in a leg's payload to find an amount (cart-kind vs.
 *      itinerary-kind vs. booking-kind diverge). Those cross-cutting
 *      checks are the shell's job — hence this module.
 *
 *   3. **Decimal safety.** Summing user-money strings correctly needs
 *      scaled-integer math; we do it once, here, rather than scattering
 *      `parseFloat(...)` across the orchestrator.
 *
 * What this module does NOT do:
 *   - Call the pricing tools. The orchestrator dispatches those through
 *     `router.ts`; this module only receives already-priced results.
 *   - Attach the envelope. Caller does `attachTripSummary(body, {payload})`
 *     after we hand them the payload.
 *   - Persist trip state. See `trip-state.ts`.
 */

import type { AttachedSummary, TripLegRef, TripSummaryPayload } from "@lumo/agent-sdk";

// ──────────────────────────────────────────────────────────────────────────
// Input — one entry per priced leg
// ──────────────────────────────────────────────────────────────────────────

/**
 * The orchestrator's view of a leg after pricing succeeded. Constructed
 * by extracting `_lumo_summary` from the pricing tool's response and
 * pairing it with the trip-level metadata the orchestrator already
 * knows (agent_id, chosen tool_name for the *bookable* step, ordering
 * and DAG edges derived from the user intent).
 */
export interface PricedLeg {
  /** Matches the specialist's manifest.agent_id. */
  agent_id: string;
  /**
   * The *bookable* tool that will run on confirm — NOT the pricing
   * tool the orchestrator just called to produce this summary. The
   * SDK's registry already guarantees pricing and bookable tools agree
   * on summary_hash; we copy the bookable name through to the trip envelope.
   */
  tool_name: string;
  /** 1-indexed position in the trip. Must be dense across all legs. */
  order: number;
  /** Orders of other legs this leg depends on. Each must be <order and >=1. */
  depends_on: number[];
  /** The v0.1 AttachedSummary the pricing tool returned — verbatim. */
  summary: AttachedSummary;
  /**
   * Decimal string matching /^\d+(\.\d+)?$/. Source: the pricing tool
   * response body's domain `total_amount` (flight) or `subtotal` (cart),
   * extracted by the orchestrator before calling us — we don't try to
   * reach into `summary.payload` because its shape varies by kind.
   */
  leg_amount: string;
  /** ISO 4217 — must match other legs. */
  currency: string;
}

/**
 * Assembly input. The trip-level title is caller-provided (typically
 * synthesized by Claude from the user utterance during planning); the
 * total is either provided and verified, or derived and authoritative.
 */
export interface AssembleTripInput {
  /** e.g. "Chicago → Las Vegas, May 1–3". Non-empty. */
  trip_title: string;
  legs: PricedLeg[];
  /**
   * Optional sanity check. If provided, the sum of leg_amounts must
   * match this exactly (string-equal after canonical scaling). If
   * omitted, the sum is authoritative and returned as-is.
   *
   * Callers that have an expected total from the user intent (e.g.
   * budget guardrail) should pass it — we want the assembler to reject
   * arithmetic drift rather than silently paper over it.
   */
  expected_total?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Errors — structured so the orchestrator can surface them to Claude
// ──────────────────────────────────────────────────────────────────────────

/**
 * Thrown when assembly cannot proceed. Distinct from the SDK's generic
 * TypeError so the orchestrator can catch-and-stringify these into
 * user-safe diagnostics without leaking SDK internals.
 */
export class TripAssemblyError extends Error {
  readonly code: TripAssemblyErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: TripAssemblyErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "TripAssemblyError";
    this.code = code;
    this.detail = detail;
  }
}

export type TripAssemblyErrorCode =
  | "empty_legs"
  | "currency_mismatch"
  | "invalid_amount_format"
  | "total_mismatch"
  | "invalid_trip_title";

// ──────────────────────────────────────────────────────────────────────────
// Assembly
// ──────────────────────────────────────────────────────────────────────────

/**
 * Assemble a TripSummaryPayload from per-leg priced results.
 *
 * Does NOT:
 *   - re-validate DAG edges (leave to `attachTripSummary`)
 *   - re-validate order density (leave to `attachTripSummary`)
 *   - produce the compound hash (leave to `attachTripSummary`)
 *
 * Does:
 *   - Reject empty leg sets up front (`attachTripSummary` would too, but
 *     a distinct error code is more actionable for the orchestrator).
 *   - Reject mixed currencies (the SDK doesn't — it's orthogonal to hash).
 *   - Sum `leg_amount`s with scaled-integer math; verify against
 *     `expected_total` if the caller supplied one.
 *
 * Determinism: given the same input, output is byte-identical. Legs are
 * sorted by `order` so callers can pass them in any input ordering.
 */
export function assembleTripSummary(input: AssembleTripInput): TripSummaryPayload {
  if (typeof input.trip_title !== "string" || input.trip_title.trim().length === 0) {
    throw new TripAssemblyError(
      "invalid_trip_title",
      "trip_title must be a non-empty string",
    );
  }

  if (!Array.isArray(input.legs) || input.legs.length === 0) {
    throw new TripAssemblyError(
      "empty_legs",
      "Cannot assemble a trip with zero legs — pricing must succeed for every leg first.",
    );
  }

  // Canonical ordering: caller may have passed legs unsorted (pricing
  // can complete in parallel). Sort by declared `order` so the resulting
  // payload is stable regardless of how pricing races resolved.
  const sortedLegs = input.legs.slice().sort((a, b) => a.order - b.order);
  // Hoist the head leg explicitly. The emptiness guard above ensures
  // sortedLegs[0] is defined, but `noUncheckedIndexedAccess` can't
  // carry that proof across the array access — the explicit binding
  // makes the invariant local.
  const firstLeg = sortedLegs[0];
  if (!firstLeg) {
    // Unreachable — the `input.legs.length === 0` check above catches
    // this. Kept as a defensive belt for the type narrower.
    throw new TripAssemblyError("empty_legs", "Cannot assemble a trip with zero legs.");
  }

  // Currency agreement — capture from the first leg, reject any dissenters.
  const currency = firstLeg.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TripAssemblyError(
      "currency_mismatch",
      `Leg 1 currency "${String(currency)}" is not a valid ISO 4217 code`,
      { leg_order: firstLeg.order, currency: firstLeg.currency },
    );
  }
  for (const leg of sortedLegs) {
    if (leg.currency !== currency) {
      throw new TripAssemblyError(
        "currency_mismatch",
        `Leg ${leg.order} currency "${leg.currency}" does not match trip currency "${currency}". Mixed-currency trips are not supported in the single-confirm flow.`,
        { leg_order: leg.order, leg_currency: leg.currency, trip_currency: currency },
      );
    }
  }

  // Amount validation + sum. Scaled-integer to avoid float drift.
  const amounts: string[] = [];
  for (const leg of sortedLegs) {
    if (typeof leg.leg_amount !== "string" || !/^\d+(\.\d+)?$/.test(leg.leg_amount)) {
      throw new TripAssemblyError(
        "invalid_amount_format",
        `Leg ${leg.order} leg_amount "${String(leg.leg_amount)}" is not a valid decimal string`,
        { leg_order: leg.order, leg_amount: leg.leg_amount },
      );
    }
    amounts.push(leg.leg_amount);
  }
  const total = sumDecimalStrings(amounts);

  if (input.expected_total !== undefined) {
    if (
      typeof input.expected_total !== "string" ||
      !/^\d+(\.\d+)?$/.test(input.expected_total)
    ) {
      throw new TripAssemblyError(
        "invalid_amount_format",
        `expected_total "${String(input.expected_total)}" is not a valid decimal string`,
        { expected_total: input.expected_total },
      );
    }
    // Normalize both sides to the same scale before comparing — so
    // "247" and "247.00" and "247.0000" all compare equal.
    if (!decimalStringsEqual(total, input.expected_total)) {
      throw new TripAssemblyError(
        "total_mismatch",
        `Leg amounts sum to ${total} ${currency}, which does not match expected_total ${input.expected_total} ${currency}.`,
        {
          computed_total: total,
          expected_total: input.expected_total,
          currency,
          per_leg: sortedLegs.map((l) => ({ order: l.order, amount: l.leg_amount })),
        },
      );
    }
  }

  const legs: TripLegRef[] = sortedLegs.map((l) => ({
    agent_id: l.agent_id,
    tool_name: l.tool_name,
    // Shape each leg into the SDK's TripLegRef — `attachTripSummary`
    // will itself validate leg-hash format and DAG shape; we don't
    // duplicate those checks here.
    summary: l.summary,
    order: l.order,
    depends_on: l.depends_on.slice().sort((x, y) => x - y),
  }));

  return {
    trip_title: input.trip_title,
    total_amount: total,
    currency,
    legs,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Decimal helpers — money-safe string sum
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sum decimal strings without going through IEEE-754 floats.
 *
 * Approach: find the max fractional length across inputs, scale each
 * to that precision as a BigInt, sum, then format back. The output's
 * fractional length equals the max input fractional length (so
 * ["100", "0.50"] sums to "100.50", not "100.5" or "100").
 *
 * Edge cases:
 *   - ["100"] → "100" (no scaling)
 *   - ["100.5", "0.005"] → "100.505"
 *   - [] → "0" (unused here — callers guard against empty legs)
 */
export function sumDecimalStrings(parts: string[]): string {
  if (parts.length === 0) return "0";

  let maxFrac = 0;
  for (const p of parts) {
    const dot = p.indexOf(".");
    const frac = dot < 0 ? 0 : p.length - dot - 1;
    if (frac > maxFrac) maxFrac = frac;
  }

  let sum = 0n;
  for (const p of parts) {
    sum += toScaledBigInt(p, maxFrac);
  }

  if (maxFrac === 0) return sum.toString();

  // Format: split integer and fractional parts with left-pad on the
  // fractional side for small sums (e.g. 5 at scale 2 → "0.05").
  const s = sum.toString();
  if (s.length <= maxFrac) {
    return "0." + s.padStart(maxFrac, "0");
  }
  const cut = s.length - maxFrac;
  return s.slice(0, cut) + "." + s.slice(cut);
}

/**
 * Equality for decimal strings at possibly-different scales.
 * "247" === "247.00" === "247.000" all return true; "247" vs "247.01"
 * returns false.
 */
export function decimalStringsEqual(a: string, b: string): boolean {
  const aFrac = fractionalLength(a);
  const bFrac = fractionalLength(b);
  const scale = Math.max(aFrac, bFrac);
  return toScaledBigInt(a, scale) === toScaledBigInt(b, scale);
}

function fractionalLength(s: string): number {
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Parse a decimal string to a BigInt at the given scale.
 * "12.3" at scale 4 → 123000n. Regex-guarded upstream.
 */
function toScaledBigInt(s: string, scale: number): bigint {
  const dot = s.indexOf(".");
  if (dot < 0) {
    // Integer string — append `scale` zeros.
    return BigInt(s + "0".repeat(scale));
  }
  const intPart = s.slice(0, dot);
  const fracPart = s.slice(dot + 1);
  if (fracPart.length > scale) {
    // Shouldn't happen given the regex + scale computation, but guard
    // rather than silently truncate.
    throw new Error(
      `toScaledBigInt: fractional part "${fracPart}" longer than scale ${scale}`,
    );
  }
  const padded = fracPart.padEnd(scale, "0");
  return BigInt(intPart + padded);
}
