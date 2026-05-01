/**
 * CHAT-PROFILE-AUTOFILL-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/chat-profile-autofill.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyBookingProfileDefaults,
  bookingProfileSnapshotToPii,
  bookingProfileSnapshotToPrompt,
  buildBookingProfileSnapshotFromRows,
  missingBookingProfileFields,
} from "../lib/booking-profile-core.ts";

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

const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const router = readFileSync("lib/router.ts", "utf8");
const registry = readFileSync("lib/integrations/registry.ts", "utf8");
const systemPrompt = readFileSync("lib/system-prompt.ts", "utf8");

console.log("\nchat profile autofill");

t("bookingProfileSnapshot marks approved complete profile fields present", () => {
  const snapshot = completeSnapshot();
  assert.equal(snapshot.fields.name.status, "present");
  assert.equal(snapshot.fields.email.status, "present");
  assert.equal(snapshot.fields.payment_method_id.status, "present");
  assert.equal(snapshot.fields.traveler_profile.status, "present");
  assert.deepEqual(snapshot.required_missing_fields, []);
  assert.equal(
    snapshot.prefill_summary,
    "Booking for Prasanth Kalas · prasanth.kalas@lumo.rentals · Visa ••4242",
  );
});

t("bookingProfileSnapshot asks specifically for missing payment only", () => {
  const snapshot = buildBookingProfileSnapshotFromRows({
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
    paymentMethod: null,
  });

  assert.equal(snapshot.fields.name.status, "present");
  assert.equal(snapshot.fields.email.status, "present");
  assert.equal(snapshot.fields.payment_method_id.status, "missing");
  assert.deepEqual(missingBookingProfileFields(snapshot), ["payment_method_id"]);
  assert.match(
    bookingProfileSnapshotToPrompt(snapshot),
    /Missing required booking fields: payment_method_id\. Ask only for these fields\./,
  );
});

t("bookingProfileSnapshot respects scopes and does not leak unapproved fields", () => {
  const snapshot = buildBookingProfileSnapshotFromRows({
    userId: "user_1",
    grantedScopes: ["profile:name"],
    profile: {
      full_name: "Prasanth Kalas",
      email: "prasanth.kalas@lumo.rentals",
    },
    paymentMethod: {
      id: "pm_card_visa",
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: 2030,
    },
  });

  assert.equal(snapshot.fields.name.status, "present");
  assert.equal(snapshot.fields.email.status, "not_in_scope");
  assert.equal(snapshot.fields.payment_method_id.status, "not_in_scope");
  assert.deepEqual(bookingProfileSnapshotToPii(snapshot), {
    name: "Prasanth Kalas",
  });
});

t("profile PII defaults fill booking tool args without user re-entry", () => {
  const pii = bookingProfileSnapshotToPii(completeSnapshot());
  const args = applyBookingProfileDefaults({ offerId: "off_123" }, pii);
  assert.equal(args.paymentMethodId, "pm_card_visa");
  assert.equal(Array.isArray(args.passengers), true);
  assert.deepEqual(args.passengers[0], {
    type: "adult",
    given_name: "Prasanth",
    family_name: "Kalas",
    email: "prasanth.kalas@lumo.rentals",
    source: "profile",
  });
});

t("system prompt helper instructs prefilled confirmation instead of generic data collection", () => {
  const prompt = bookingProfileSnapshotToPrompt(completeSnapshot());
  assert.match(prompt, /BOOKING PROFILE PREFILL:/);
  assert.match(prompt, /payment_method_id: present \(Visa ••4242\)/);
  assert.match(prompt, /Do not ask for name, email, phone, traveler, or payment details/);
  assert.doesNotMatch(prompt, /I'll need your name, email, and payment details/);
  assert.match(systemPrompt, /bookingProfileSnapshotToPrompt/);
  assert.match(systemPrompt, /bookingProfileBlock/);
});

t("orchestrator and router wire snapshot through booking dispatch", () => {
  assert.match(chatRoute, /bookingProfileSnapshotForSession/);
  assert.match(chatRoute, /bookingProfileSnapshotToPii/);
  assert.match(orchestrator, /bookingProfileSnapshot\(input\.user_id, connectedApprovalScopes\)/);
  assert.match(orchestrator, /bookingProfile,\n\s+\}\);/);
  assert.match(orchestrator, /user_pii: userPiiForDispatch/);
  assert.match(router, /applyBookingProfileDefaults\(args, piiPayload\)/);
  assert.match(registry, /pii_required: \["name", "email", "phone", "dob", "payment_method_id", "traveler_profile"\]/);
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
