/**
 * WEB-COMPOUND-LEG-DETAIL-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/web-compound-leg-detail.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compoundLegDetailModel,
  elapsedLabel,
  hasCompoundLegMetadata,
  isCompoundTerminalStatus,
  mergeCompoundLegMetadata,
} from "../lib/compound-leg-detail.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.log(`  ✗ ${name}\n    ${error.stack ?? error.message}`);
  }
};

console.log("\nweb compound leg detail");

const strip = readFileSync("components/CompoundLegStrip.tsx", "utf8");
const detail = readFileSync("components/CompoundLegDetailContent.tsx", "utf8");
const page = readFileSync("app/page.tsx", "utf8");
const fixture = readFileSync("app/fixtures/compound-leg-strip/page.tsx", "utf8");

const legs = [
  {
    leg_id: "leg_flight",
    agent_id: "lumo-flights",
    agent_display_name: "Lumo Flights",
    description: "Booking flight ORD → LAS",
    status: "committed",
  },
  {
    leg_id: "leg_hotel",
    agent_id: "lumo-hotels",
    agent_display_name: "Lumo Hotels",
    description: "Booking hotel near the Strip",
    status: "pending",
    depends_on: ["leg_flight"],
  },
  {
    leg_id: "leg_restaurant",
    agent_id: "lumo-restaurants",
    agent_display_name: "Lumo Restaurants",
    description: "Booking dinner reservation",
    status: "pending",
  },
];

t("pending branch mirrors iOS queued copy and previous-leg heuristic", () => {
  const model = compoundLegDetailModel({
    leg: legs[1],
    status: "pending",
    metadata: {},
    settled: false,
    allLegs: legs,
  });

  assert.deepEqual(model.lines, [
    {
      label: "QUEUED",
      text: "Waiting for Booking flight ORD → LAS",
      tone: "secondary",
    },
  ]);
  assert.equal(model.elapsed_started_at, null);
});

t("in-flight branch mirrors iOS searching copy and exposes live elapsed start", () => {
  const model = compoundLegDetailModel({
    leg: legs[0],
    status: "in_flight",
    metadata: { timestamp: "2026-05-01T17:05:07.000Z" },
    settled: false,
    allLegs: legs,
  });

  assert.deepEqual(model.lines, [
    {
      label: "SEARCHING",
      text: "Duffel — available flights",
      tone: "primary",
    },
  ]);
  assert.equal(model.elapsed_started_at, "2026-05-01T17:05:07.000Z");
  assert.equal(elapsedLabel("2026-05-01T17:05:07.000Z", new Date("2026-05-01T17:06:10Z")), "Elapsed: 1m 3s");
});

t("committed branch mirrors iOS confirmed copy, reference, and sorted evidence", () => {
  const model = compoundLegDetailModel({
    leg: legs[0],
    status: "committed",
    metadata: {
      provider_reference: "DUFFEL_ord_9f83a21",
      evidence: { seats: "1", carrier: "United", route: "ORD → LAS" },
    },
    settled: true,
    allLegs: legs,
  });

  assert.deepEqual(model.lines, [
    { label: "CONFIRMED", text: "Booking complete.", tone: "success" },
    {
      label: "REFERENCE",
      text: "DUFFEL_ord_9f83a21",
      tone: "secondary",
      mono: true,
    },
    { label: "CARRIER", text: "United", tone: "secondary" },
    { label: "ROUTE", text: "ORD → LAS", tone: "secondary" },
    { label: "SEATS", text: "1", tone: "secondary" },
  ]);
});

t("failure family mirrors iOS six-code humanization and saga action copy", () => {
  const failed = compoundLegDetailModel({
    leg: legs[1],
    status: "failed",
    metadata: { evidence: { reason: "rate_unavailable" } },
    settled: true,
    allLegs: legs,
  });
  const rolledBack = compoundLegDetailModel({
    leg: legs[0],
    status: "rolled_back",
    metadata: { evidence: { reason: "duplicate_idempotency" } },
    settled: true,
    allLegs: legs,
  });
  const rollbackFailed = compoundLegDetailModel({
    leg: legs[2],
    status: "rollback_failed",
    metadata: { evidence: { reason: "provider_timeout" } },
    settled: true,
    allLegs: legs,
  });

  assert.deepEqual(failed.lines, [
    {
      label: "FAILED",
      text: "Rate unavailable — provider re-quoted between price-lock and book.",
      tone: "error",
    },
    {
      label: "SAGA",
      text: "Saga halted; dependent legs will roll back.",
      tone: "secondary",
    },
  ]);
  assert.equal(
    rolledBack.lines[0]?.text,
    "Duplicate idempotency key — booking may already exist.",
  );
  assert.equal(
    rolledBack.lines[1]?.text,
    "This leg was rolled back as part of a saga compensation; the booking did not commit.",
  );
  assert.equal(rollbackFailed.lines[0]?.text, "Provider timed out before confirming.");
  assert.equal(
    rollbackFailed.lines[1]?.text,
    "Compensating rollback could not complete — escalated to the Lumo team.",
  );
});

t("manual review branch mirrors iOS copy and optional reason line", () => {
  const model = compoundLegDetailModel({
    leg: legs[2],
    status: "manual_review",
    metadata: { evidence: { reason: "Dinner time needs staff approval." } },
    settled: true,
    allLegs: legs,
  });

  assert.deepEqual(model.lines, [
    {
      label: "MANUAL REVIEW",
      text: "Awaiting manual review — the Lumo team will follow up shortly.",
      tone: "warning",
    },
    { label: "REASON", text: "Dinner time needs staff approval.", tone: "secondary" },
  ]);
});

t("metadata helpers keep old dispatch rows non-expandable and merge live updates", () => {
  assert.equal(hasCompoundLegMetadata({}), false);
  assert.equal(hasCompoundLegMetadata({ timestamp: "2026-05-01T17:05:07.000Z" }), true);
  assert.deepEqual(
    mergeCompoundLegMetadata(
      { timestamp: "2026-05-01T17:05:07.000Z", evidence: { carrier: "United" } },
      { provider_reference: "DUFFEL_ord_9f83a21", evidence: { route: "ORD → LAS" } },
    ),
    {
      timestamp: "2026-05-01T17:05:07.000Z",
      provider_reference: "DUFFEL_ord_9f83a21",
      evidence: { carrier: "United", route: "ORD → LAS" },
    },
  );
});

t("compound strip supports multi-expand state keyed by leg id", () => {
  assert.match(strip, /depends_on\?: string\[\]/);
  assert.match(strip, /expandedLegIds\?: Record<string, boolean>/);
  assert.match(strip, /onToggleLeg\?: \(legId: string\) => void/);
  assert.match(strip, /aria-expanded=\{isExpanded\}/);
  assert.match(strip, /rotate-90/);
  assert.match(page, /compoundExpandedLegs/);
  assert.match(page, /\[legId\]: !prev\[legId\]/);
});

t("detail ticker uses a one-second interval and suppresses on terminal states", () => {
  assert.match(detail, /window\.setInterval\(\(\) => setNow\(new Date\(\)\), 1000\)/);
  assert.match(detail, /window\.clearInterval\(id\)/);
  assert.equal(isCompoundTerminalStatus("committed"), true);
  const model = compoundLegDetailModel({
    leg: legs[0],
    status: "in_flight",
    metadata: { timestamp: "2026-05-01T17:05:07.000Z" },
    settled: true,
    allLegs: legs,
  });
  assert.equal(model.elapsed_started_at, null);
});

t("fixture exposes five light detail states and a dark committed capture target", () => {
  for (const state of ["pending", "in_flight", "committed", "failed", "manual_review"]) {
    assert.match(fixture, new RegExp(`${state}:`));
  }
  assert.match(fixture, /expandedLegIds=\{detail \? \{ \[detail\.legId\]: true \} : undefined\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
