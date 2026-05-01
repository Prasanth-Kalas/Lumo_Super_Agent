/**
 * Pure helpers for FlightOffersSelectCard.
 *
 * Extracted into a `.ts` file so the test runner (which uses
 * `--experimental-strip-types` and only handles `.ts`, not `.tsx`)
 * can import them directly. The component itself imports from here
 * and re-exports for convenience.
 */

export interface FlightOffersHelperOffer {
  offer_id: string;
  total_amount: string;
  total_currency: string;
  owner: { name: string };
  slices: Array<{
    segments: Array<{
      departing_at: string;
    }>;
  }>;
}

export function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  const sym =
    currency === "USD" ? "$" :
    currency === "EUR" ? "€" :
    currency === "GBP" ? "£" :
    "";
  return sym ? `${sym}${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    const m = /T(\d{2}):(\d{2})/.exec(iso);
    return m ? `${m[1]}:${m[2]}` : iso;
  }
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(d);
}

/**
 * The natural-language submit text for an offer. The orchestrator's
 * post-selection handler parses the `offer_id` substring out of this
 * — the rest is human-readable scaffolding for the chat thread. Pure
 * function so tests + the React component can both rely on the same
 * exact contract.
 */
export function buildOfferSubmitText(offer: FlightOffersHelperOffer): string {
  const firstSlice = offer.slices[0]!;
  const firstSeg = firstSlice.segments[0]!;
  const onward =
    firstSlice.segments.length > 1 ? " (with connection)" : " direct";
  return `Go with offer ${offer.offer_id} — the ${formatTime(firstSeg.departing_at)} ${offer.owner.name}${onward} for ${formatMoney(offer.total_amount, offer.total_currency)}.`;
}
