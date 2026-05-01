"use client";

/**
 * Fixture-only page for CHAT-CONFIRMATION-PAYLOAD-EXTEND-1. It renders
 * the enriched ItineraryConfirmationCard with traveler/payment rows so
 * screenshot capture can verify the visible autofill contract without
 * running the full orchestrator.
 */

import {
  ItineraryConfirmationCard,
  type ItineraryPayload,
} from "@/components/ItineraryConfirmationCard";

const PAYLOAD: ItineraryPayload = {
  kind: "structured-itinerary",
  offer_id: "off_lumo_vegas_demo",
  total_amount: "248.00",
  total_currency: "USD",
  traveler_summary: "Prasanth Kalas · prasanth.kalas@lumo.rentals",
  payment_summary: "Visa ••4242",
  prefilled: true,
  missing_fields: [],
  slices: [
    {
      origin: "ORD",
      destination: "LAS",
      segments: [
        {
          origin: "ORD",
          destination: "LAS",
          departing_at: "2026-05-09T09:30:00Z",
          arriving_at: "2026-05-09T11:26:00Z",
          carrier: "UA",
          flight_number: "1879",
        },
      ],
    },
    {
      origin: "LAS",
      destination: "ORD",
      segments: [
        {
          origin: "LAS",
          destination: "ORD",
          departing_at: "2026-05-11T17:45:00Z",
          arriving_at: "2026-05-11T23:25:00Z",
          carrier: "UA",
          flight_number: "1880",
        },
      ],
    },
  ],
};

export default function ConfirmationCardFixture() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high px-5 py-10">
      <div className="mx-auto max-w-2xl">
        <ItineraryConfirmationCard
          payload={PAYLOAD}
          onConfirm={() => {}}
          onCancel={() => {}}
          onDifferentTraveler={() => {}}
          onMissingFieldsSubmit={() => {}}
        />
      </div>
    </main>
  );
}
