/**
 * CHAT-CONFIRMATION-PAYLOAD-EXTEND-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/chat-confirmation-payload-extend.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bookingProfileSnapshotToConfirmationPayload,
  buildBookingProfileSnapshotFromRows,
} from "../lib/booking-profile-core.ts";

const component = readFileSync("components/ItineraryConfirmationCard.tsx", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const page = readFileSync("app/page.tsx", "utf8");

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.stack ?? e.message}`);
  }
};

console.log("\nchat confirmation payload extend");

t("complete booking profile becomes visible traveler and payment summary", () => {
  const payload = bookingProfileSnapshotToConfirmationPayload(completeSnapshot());
  assert.deepEqual(payload, {
    traveler_summary: "Prasanth Kalas · prasanth.kalas@lumo.rentals",
    payment_summary: "Visa ••4242",
    prefilled: true,
    missing_fields: [],
  });
});

t("missing payment is surfaced precisely, not as generic details", () => {
  const payload = bookingProfileSnapshotToConfirmationPayload(
    buildBookingProfileSnapshotFromRows({
      userId: "user_1",
      grantedScopes: [
        "profile:name",
        "profile:email",
        "profile:payment_method_id",
        "profile:traveler_profile",
      ],
      profile: {
        full_name: "Prasanth Kalas",
        email: "prasanth.kalas@lumo.rentals",
      },
      paymentMethod: null,
    }),
  );
  assert.equal(payload.traveler_summary, "Prasanth Kalas · prasanth.kalas@lumo.rentals");
  assert.equal(payload.payment_summary, null);
  assert.equal(payload.prefilled, false);
  assert.deepEqual(payload.missing_fields, ["payment_method_id"]);
});

t("orchestrator enriches structured-itinerary display payload without changing hash", () => {
  assert.match(orchestrator, /withBookingConfirmationProfilePayload/);
  assert.match(orchestrator, /bookingProfileSnapshotToConfirmationPayload/);
  assert.match(orchestrator, /summary\.kind !== "structured-itinerary"/);
  assert.match(orchestrator, /hash remains the agent-authoritative/);
});

t("ItineraryConfirmationCard renders prefilled traveler and payment rows", () => {
  assert.match(component, /traveler_summary/);
  assert.match(component, /payment_summary/);
  assert.match(component, /Prefilled from approved profile/);
  assert.match(component, /ProfileSummaryRow/);
});

t("ItineraryConfirmationCard renders missing-field branch and different-traveler action", () => {
  assert.match(component, /missing_fields/);
  assert.match(component, /Need: \{missingFields\.map\(missingFieldLabel\)\.join\(", "\)\}/);
  assert.match(component, /Different traveler/);
  assert.match(component, /onMissingFieldsSubmit/);
});

t("chat shell wires the buttons through the same submit path as chips", () => {
  assert.match(page, /onDifferentTraveler=\{\(\) => void sendText\("Use a different traveler"\)\}/);
  assert.match(page, /onMissingFieldsSubmit=\{\(message\) => void sendText\(message\)\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function completeSnapshot() {
  return buildBookingProfileSnapshotFromRows({
    userId: "user_1",
    grantedScopes: [
      "profile:name",
      "profile:email",
      "profile:payment_method_id",
      "profile:traveler_profile",
    ],
    profile: {
      full_name: "Prasanth Kalas",
      email: "prasanth.kalas@lumo.rentals",
    },
    userProfile: { extra: {} },
    paymentMethod: {
      id: "pm_card_visa",
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: 2030,
    },
  });
}
