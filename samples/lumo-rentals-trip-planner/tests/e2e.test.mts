import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import agent, { fixtureRental } from "../src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../../_shared/runtime.ts";
import {
  assertCostWithinManifest,
  validateSampleManifestFile,
} from "../../_shared/validation.ts";

const validation = validateSampleManifestFile(
  new URL("../lumo-agent.json", import.meta.url).pathname,
);
assert.deepEqual(validation.errors, []);

const stripeFixture = JSON.parse(
  readFileSync(new URL("../fixtures/stripe-charge.json", import.meta.url), "utf8"),
);
const calendarFixture = JSON.parse(
  readFileSync(new URL("../fixtures/calendar-event.json", import.meta.url), "utf8"),
);
const rental = fixtureRental();

for (const mode of ["dev", "sandbox"] as const) {
  const ctx = createSampleContext({
    request_id: `rental_${mode}`,
    connectors: {
      "lumo-rentals": {
        search: async () => rental,
        reserve: async () => ({ reservation_id: "res_sample_lumo_rental_001" }),
      },
      stripe: {
        charge: async () => stripeFixture,
      },
      "google-calendar": {
        createEvent: async () => calendarFixture,
      },
    },
  });

  const pending = await invokeSampleAgent(
    agent,
    "book_rental",
    { rental },
    ctx,
  );
  assert.equal(pending.status, "needs_confirmation");
  assert.match(pending.confirmation_card?.side_effect_summary ?? "", /Stripe/);
  assert.equal(pending.confirmation_card?.reversibility, "compensating");
  assertCostWithinManifest(validation, pending.cost_actuals.usd);

  const booked = await invokeSampleAgent(
    agent,
    "confirm_booking",
    { rental, request_id: `rental_${mode}` },
    ctx,
  );
  const outputs = booked.outputs as {
    charge_id: string;
    calendar_event_id: string;
  };
  assert.equal(booked.status, "succeeded");
  assert.equal(outputs.charge_id, stripeFixture.charge_id);
  assert.equal(outputs.calendar_event_id, calendarFixture.event_id);
  assert.deepEqual(
    booked.provenance_evidence.sources.map((source) => source.type),
    [
      "connector.stripe",
      "connector.lumo-rentals",
      "connector.google-calendar",
      "idempotency",
    ],
  );
  assertCostWithinManifest(validation, booked.cost_actuals.usd);
}
