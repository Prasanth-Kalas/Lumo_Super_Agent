/**
 * WEB-SCREENS-1 trips helpers.
 *
 * Run: node --experimental-strip-types tests/web-screens-trips.test.mjs
 *
 * Covers the four states the /trips and /trips/[id] pages distinguish:
 *   authenticated render (real row → summary), empty state (no legs),
 *   error state (unknown status), and the cancellable-status predicate
 *   that drives the page's Cancel button.
 */

import assert from "node:assert/strict";
import {
  findTripForUser,
  formatTotal,
  formatTripStatus,
  isCancellable,
  statusPillClass,
  summarize,
} from "../lib/web-screens-trips.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log("\nweb-screens trips helpers");

t("authenticated render — committed trip summary", () => {
  const row = {
    trip_id: "trp_abc",
    session_id: "sess_1",
    status: "committed",
    payload: {
      trip_title: "Vegas weekend",
      total_amount: "742.50",
      currency: "USD",
      legs: [
        { order: 0, agent_id: "duffel", tool_name: "duffel.book" },
        { order: 1, agent_id: "booking", tool_name: "booking.book_room" },
      ],
    },
    created_at: "2026-04-30T12:00:00Z",
    updated_at: "2026-04-30T12:00:00Z",
    cancel_requested_at: null,
  };
  const s = summarize(row);
  assert.equal(s.title, "Vegas weekend");
  assert.equal(s.status, "Booked");
  assert.equal(s.total, "$742.50");
  assert.equal(s.leg_count, 2);
  assert.equal(s.is_cancellable, true);
  assert.equal(s.cancel_requested, false);
});

t("empty state — null legs and total", () => {
  const row = {
    trip_id: "trp_empty",
    session_id: "sess_e",
    status: "draft",
    payload: {},
    created_at: "2026-04-30T12:00:00Z",
    updated_at: "2026-04-30T12:00:00Z",
    cancel_requested_at: null,
  };
  const s = summarize(row);
  assert.equal(s.title, "Untitled trip");
  assert.equal(s.total, null);
  assert.equal(s.leg_count, 0);
  assert.equal(s.status, "Draft");
});

t("error state — unknown status falls back to Draft label", () => {
  assert.equal(formatTripStatus("never_seen"), "Draft");
  assert.match(statusPillClass("Draft"), /lumo-elevated/);
});

t("cancellable predicate — committed cancellable, terminal not", () => {
  assert.equal(isCancellable("draft", null), true);
  assert.equal(isCancellable("dispatching", null), true);
  assert.equal(isCancellable("committed", null), true);
  assert.equal(isCancellable("rolled_back", null), false);
  assert.equal(isCancellable("rollback_failed", null), false);
  // already-requested locks the button regardless of status
  assert.equal(isCancellable("dispatching", "2026-04-30T01:00:00Z"), false);
});

t("formatTotal handles invalid amounts", () => {
  assert.equal(formatTotal(undefined, "USD"), null);
  assert.equal(formatTotal("abc", "USD"), null);
  assert.equal(formatTotal("100", "USD"), "$100.00");
});

t("findTripForUser scopes by id, returns null for miss", () => {
  const rows = [
    { trip_id: "a" },
    { trip_id: "b" },
  ];
  // @ts-expect-error – partial fixture is fine for the matcher
  assert.deepEqual(findTripForUser(rows, "b"), { trip_id: "b" });
  // @ts-expect-error – partial fixture is fine for the matcher
  assert.equal(findTripForUser(rows, "c"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
