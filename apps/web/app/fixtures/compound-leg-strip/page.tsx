/**
 * Fixture-only page for WEB-COMPOUND-VIEW-1. It renders the inline
 * compound leg strip in both active and terminal states without
 * opening the live SSE stream, so screenshot capture is deterministic.
 */

import CompoundLegStrip, {
  type CompoundLegStripPayload,
} from "@/components/CompoundLegStrip";

const DISPATCH_PAYLOAD: CompoundLegStripPayload = {
  kind: "assistant_compound_dispatch",
  compound_transaction_id: "ct_demo_vegas_weekend",
  legs: [
    {
      leg_id: "leg_flight",
      agent_id: "lumo-flights",
      agent_display_name: "Lumo Flights",
      description: "Booking flight ORD → LAS",
      status: "in_flight",
    },
    {
      leg_id: "leg_hotel",
      agent_id: "lumo-hotels",
      agent_display_name: "Lumo Hotels",
      description: "Booking hotel near the Strip",
      status: "pending",
    },
    {
      leg_id: "leg_restaurant",
      agent_id: "lumo-restaurants",
      agent_display_name: "Lumo Restaurants",
      description: "Booking dinner reservation",
      status: "pending",
    },
  ],
};

const SETTLED_PAYLOAD: CompoundLegStripPayload = {
  ...DISPATCH_PAYLOAD,
  legs: DISPATCH_PAYLOAD.legs.map((leg) => ({
    ...leg,
    status: "committed",
  })),
};

const DETAIL_BASE: CompoundLegStripPayload = {
  ...DISPATCH_PAYLOAD,
  legs: [
    {
      ...DISPATCH_PAYLOAD.legs[0]!,
      status: "committed",
      timestamp: "2026-05-01T17:05:02.000Z",
      provider_reference: "DUFFEL_ord_9f83a21",
      evidence: {
        carrier: "United",
        depart: "May 9, 09:10",
        route: "ORD → LAS",
        seats: "1",
      },
    },
    {
      ...DISPATCH_PAYLOAD.legs[1]!,
      status: "pending",
      depends_on: ["leg_flight"],
      timestamp: "2026-05-01T17:05:05.000Z",
      evidence: {
        reason: "Hotel city comes from confirmed arrival city.",
      },
    },
    {
      ...DISPATCH_PAYLOAD.legs[2]!,
      status: "pending",
      depends_on: ["leg_hotel"],
    },
  ],
};

const DETAIL_PAYLOADS: Record<string, { payload: CompoundLegStripPayload; legId: string }> = {
  pending: {
    payload: DETAIL_BASE,
    legId: "leg_hotel",
  },
  in_flight: {
    payload: {
      ...DETAIL_BASE,
      legs: DETAIL_BASE.legs.map((leg) =>
        leg.leg_id === "leg_hotel"
          ? {
              ...leg,
              status: "in_flight",
              timestamp: "2026-05-01T17:05:07.000Z",
              evidence: { provider_status: "searching" },
            }
          : leg,
      ),
    },
    legId: "leg_hotel",
  },
  committed: {
    payload: DETAIL_BASE,
    legId: "leg_flight",
  },
  failed: {
    payload: {
      ...DETAIL_BASE,
      legs: DETAIL_BASE.legs.map((leg) =>
        leg.leg_id === "leg_hotel"
          ? {
              ...leg,
              status: "failed",
              timestamp: "2026-05-01T17:05:14.000Z",
              evidence: { reason: "rate_unavailable" },
            }
          : leg,
      ),
    },
    legId: "leg_hotel",
  },
  manual_review: {
    payload: {
      ...DETAIL_BASE,
      legs: DETAIL_BASE.legs.map((leg) =>
        leg.leg_id === "leg_restaurant"
          ? {
              ...leg,
              status: "manual_review",
              timestamp: "2026-05-01T17:05:18.000Z",
              evidence: { reason: "Dinner time needs staff approval." },
            }
          : leg,
      ),
    },
    legId: "leg_restaurant",
  },
};

export default function CompoundLegStripFixture({
  searchParams,
}: {
  searchParams?: { state?: string };
}) {
  const state = searchParams?.state ?? "dispatch";
  const settled = state === "settled";
  const detail = DETAIL_PAYLOADS[state];
  const payload = detail?.payload ?? (settled ? SETTLED_PAYLOAD : DISPATCH_PAYLOAD);
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high px-5 py-10">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="space-y-1.5 pl-[18px]">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low">
            Lumo
          </div>
          <p className="text-[16px] leading-[1.6] text-lumo-fg">
            I kicked off the Vegas weekend plan. I’ll track each leg here as
            the flight, hotel, and dinner agents move.
          </p>
        </div>
        <div className="pl-[18px]">
          <CompoundLegStrip
            payload={payload}
            streamUrl={null}
            expandedLegIds={detail ? { [detail.legId]: true } : undefined}
          />
        </div>
      </div>
    </main>
  );
}
