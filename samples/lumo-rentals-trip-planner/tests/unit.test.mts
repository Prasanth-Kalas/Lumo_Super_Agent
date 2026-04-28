import assert from "node:assert/strict";
import agent, { fixtureRental } from "../src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../../_shared/runtime.ts";

const rental = fixtureRental();
const ctx = createSampleContext({
  connectors: {
    "lumo-rentals": {
      search: async () => rental,
      reserve: async () => ({ reservation_id: "res_sample_lumo_rental_001" }),
    },
    stripe: {
      charge: async () => ({ charge_id: "ch_sample_lumo_rental_001" }),
    },
    "google-calendar": {
      createEvent: async () => ({ event_id: "evt_lumo_rental_001" }),
    },
  },
});

const find = await invokeSampleAgent(agent, "find_rental_for_trip", {}, ctx);
assert.equal(find.status, "succeeded");
assert.equal((find.outputs as { rental_id: string }).rental_id, rental.rental_id);

const pending = await invokeSampleAgent(
  agent,
  "book_rental",
  { rental },
  ctx,
);
assert.equal(pending.status, "needs_confirmation");
assert.equal(pending.confirmation_card?.reversibility, "compensating");
assert.equal(pending.confirmation_card?.amount_cents, 24800);

const booked = await invokeSampleAgent(
  agent,
  "confirm_booking",
  { rental, request_id: "req_rental_unit" },
  ctx,
);
const outputs = booked.outputs as {
  reservation_id: string;
  charge_id: string;
  calendar_event_id: string;
};
assert.equal(booked.status, "succeeded");
assert.equal(outputs.reservation_id, "res_sample_lumo_rental_001");
assert.equal(outputs.charge_id, "ch_sample_lumo_rental_001");
assert.equal(outputs.calendar_event_id, "evt_lumo_rental_001");
assert.equal(booked.provenance_evidence.sources.length, 4);

const replay = await invokeSampleAgent(
  agent,
  "confirm_booking",
  { rental, request_id: "req_rental_unit" },
  ctx,
);
assert.equal((replay.outputs as { cached?: boolean }).cached, true);
