import {
  createDuffelClient,
  type DuffelClient,
  type DuffelOffer,
} from "./client.ts";

export interface FlightSearchInput {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string | null;
  passengers?: number;
  cabinClass?: "economy" | "premium_economy" | "business" | "first";
}

export interface OfferResult {
  id: string;
  totalAmount: string;
  totalCurrency: string;
  expiresAt: string | null;
  holdable: boolean;
  summary: string;
  slices: Array<{
    origin: string;
    destination: string;
    duration: string | null;
    segments: Array<{
      carrier: string;
      flightNumber: string | null;
      departingAt: string | null;
      arrivingAt: string | null;
    }>;
  }>;
}

export async function searchOffers(
  input: FlightSearchInput,
  client: DuffelClient = createDuffelClient(),
): Promise<OfferResult[]> {
  const request = await client.createOfferRequest({
    origin: input.origin,
    destination: input.destination,
    departDate: input.departDate,
    returnDate: input.returnDate,
    passengers: Array.from({ length: clampPassengerCount(input.passengers ?? 1) }).map(() => ({
      type: "adult" as const,
    })),
    cabinClass: input.cabinClass ?? "economy",
  });
  return (request.offers ?? [])
    .map(projectOffer)
    .sort((a, b) => Number(a.totalAmount) - Number(b.totalAmount))
    .slice(0, 12);
}

export function projectOffer(offer: DuffelOffer): OfferResult {
  const slices = (offer.slices ?? []).map((slice) => ({
    origin: slice.origin?.iata_code ?? slice.origin?.city_name ?? "unknown",
    destination: slice.destination?.iata_code ?? slice.destination?.city_name ?? "unknown",
    duration: slice.duration ?? null,
    segments: (slice.segments ?? []).map((segment) => ({
      carrier:
        segment.operating_carrier?.name ??
        segment.marketing_carrier?.name ??
        segment.marketing_carrier?.iata_code ??
        "Unknown carrier",
      flightNumber: segment.marketing_carrier_flight_number ?? null,
      departingAt: segment.departing_at ?? null,
      arrivingAt: segment.arriving_at ?? null,
    })),
  }));
  return {
    id: offer.id,
    totalAmount: offer.total_amount,
    totalCurrency: offer.total_currency,
    expiresAt: offer.expires_at ?? null,
    holdable: offer.payment_requirements?.requires_instant_payment === false,
    summary: `${slices[0]?.origin ?? "?"} to ${slices[0]?.destination ?? "?"} for ${offer.total_currency} ${offer.total_amount}`,
    slices,
  };
}

function clampPassengerCount(value: number): number {
  return Math.max(1, Math.min(9, Number.isFinite(value) ? Math.floor(value) : 1));
}
