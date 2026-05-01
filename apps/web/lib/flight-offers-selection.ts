/**
 * Server-side selection helpers for flight offer tool results.
 *
 * Duffel's internal integration returns a compact OfferResult[] shape, while
 * the web/iOS card contract expects `{ offers: [...] }` with Duffel-like
 * snake_case fields. Keep the projection here so the orchestrator never emits
 * a `flight_offers` frame the client cannot render.
 */

export function isFlightOfferDiscoveryTool(toolName: string): boolean {
  return toolName === "flight_search_offers" || toolName === "duffel_search_flights";
}

export function flightOffersSelectionPayload(toolName: string, result: unknown): unknown {
  if (toolName === "duffel_search_flights") {
    return { offers: normalizeDuffelOffersForSelection(result) };
  }
  return result;
}

export function normalizeDuffelOffersForSelection(
  result: unknown,
): Array<Record<string, unknown>> {
  const offers = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.offers)
      ? result.offers
      : [];
  return offers
    .filter(isRecord)
    .map((offer) => {
      if (typeof offer.offer_id === "string") return offer;
      const slices = Array.isArray(offer.slices) ? offer.slices.filter(isRecord) : [];
      const normalizedSlices = slices.map((slice) => {
        const origin = normalizeAirportValue(slice.origin);
        const destination = normalizeAirportValue(slice.destination);
        const segments = Array.isArray(slice.segments)
          ? slice.segments.filter(isRecord).map(normalizeDuffelSegmentForSelection)
          : [];
        return {
          origin,
          destination,
          duration: typeof slice.duration === "string" ? slice.duration : "PT0M",
          segments,
        };
      });
      const firstSegment = normalizedSlices[0]?.segments[0];
      const carrierName =
        isRecord(offer.owner) && typeof offer.owner.name === "string"
          ? offer.owner.name
          : typeof firstSegment?.carrier_name === "string"
            ? firstSegment.carrier_name
            : "Unknown carrier";
      return {
        offer_id: String(offer.id ?? ""),
        total_amount: String(offer.totalAmount ?? offer.total_amount ?? "0"),
        total_currency: String(offer.totalCurrency ?? offer.total_currency ?? "USD"),
        owner: {
          name: carrierName,
          iata_code:
            isRecord(offer.owner) && typeof offer.owner.iata_code === "string"
              ? offer.owner.iata_code
              : carrierCodeForDisplay(carrierName),
        },
        slices: normalizedSlices,
        expires_at:
          typeof offer.expiresAt === "string"
            ? offer.expiresAt
            : typeof offer.expires_at === "string"
              ? offer.expires_at
              : undefined,
      };
    })
    .filter((offer) => typeof offer.offer_id === "string" && offer.offer_id.length > 0);
}

function normalizeDuffelSegmentForSelection(segment: Record<string, unknown>) {
  const carrier = String(segment.carrier ?? "Unknown carrier");
  return {
    departing_at: String(segment.departingAt ?? segment.departing_at ?? ""),
    arriving_at: String(segment.arrivingAt ?? segment.arriving_at ?? ""),
    marketing_carrier: {
      iata_code:
        isRecord(segment.marketing_carrier) && typeof segment.marketing_carrier.iata_code === "string"
          ? segment.marketing_carrier.iata_code
          : carrierCodeForDisplay(carrier),
    },
    marketing_carrier_flight_number: String(
      segment.flightNumber ?? segment.marketing_carrier_flight_number ?? "",
    ),
    carrier_name: carrier,
  };
}

function normalizeAirportValue(value: unknown): { iata_code: string; city_name?: string } {
  if (isRecord(value)) {
    const iata = typeof value.iata_code === "string" ? value.iata_code : String(value.code ?? "");
    const city = typeof value.city_name === "string" ? value.city_name : undefined;
    return { iata_code: iata || "UNK", ...(city ? { city_name: city } : {}) };
  }
  const code = typeof value === "string" && value.trim() ? value.trim() : "UNK";
  return { iata_code: code };
}

function carrierCodeForDisplay(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, "").toUpperCase();
  return letters.slice(0, 2) || "XX";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
