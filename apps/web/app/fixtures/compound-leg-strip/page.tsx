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

export default function CompoundLegStripFixture({
  searchParams,
}: {
  searchParams?: { state?: string };
}) {
  const settled = searchParams?.state === "settled";
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
            payload={settled ? SETTLED_PAYLOAD : DISPATCH_PAYLOAD}
            streamUrl={null}
          />
        </div>
      </div>
    </main>
  );
}
