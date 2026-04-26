/**
 * Pure-helper tests for the ProactiveMomentCard. Component
 * rendering is exercised at the page level once the workspace
 * wiring lands; these tests cover the time/urgency/icon helpers
 * that the card depends on.
 *
 * Run: node --experimental-strip-types tests/proactive-moment-card-helpers.test.mjs
 */

import assert from "node:assert/strict";
import {
  formatMomentExpiry,
  formatMomentRelative,
  momentTypeIcon,
  urgencyAccent,
} from "../lib/proactive-moment-card-helpers.ts";

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

console.log("\nproactive moment card helpers");

t("urgencyAccent returns distinct CSS var per level", () => {
  const high = urgencyAccent("high");
  const medium = urgencyAccent("medium");
  const low = urgencyAccent("low");
  assert.ok(high.varName.startsWith("--lumo-urgency"));
  assert.ok(medium.varName.startsWith("--lumo-urgency"));
  assert.ok(low.varName.startsWith("--lumo-urgency"));
  assert.notEqual(high.varName, medium.varName);
  assert.notEqual(medium.varName, low.varName);
});

t("urgencyAccent labels are human-readable per level", () => {
  assert.equal(urgencyAccent("high").label, "High urgency");
  assert.equal(urgencyAccent("medium").label, "Worth checking");
  assert.equal(urgencyAccent("low").label, "FYI");
});

t("momentTypeIcon covers all 5 moment types with distinct glyphs", () => {
  const types = [
    "anomaly_alert",
    "forecast_warning",
    "pattern_observation",
    "time_to_act",
    "opportunity",
  ];
  const glyphs = new Set(types.map((typ) => momentTypeIcon(typ).glyph));
  assert.equal(glyphs.size, 5, "expected 5 distinct glyphs");
  for (const typ of types) {
    const icon = momentTypeIcon(typ);
    assert.ok(icon.glyph.length > 0, `glyph for ${typ} is empty`);
    assert.ok(icon.label.length > 0, `label for ${typ} is empty`);
  }
});

t("formatMomentRelative handles fresh/recent/old timestamps", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  assert.equal(formatMomentRelative("2026-04-26T11:59:30Z", now), "just now");
  assert.equal(formatMomentRelative("2026-04-26T11:55:00Z", now), "5m ago");
  assert.equal(formatMomentRelative("2026-04-26T09:00:00Z", now), "3h ago");
  assert.equal(formatMomentRelative("2026-04-25T12:00:00Z", now), "yesterday");
  assert.equal(formatMomentRelative("2026-04-23T12:00:00Z", now), "3d ago");
  // 8 days ago falls back to date format
  const eightDaysAgo = formatMomentRelative("2026-04-18T12:00:00Z", now);
  assert.ok(/Apr/.test(eightDaysAgo), `expected month name, got ${eightDaysAgo}`);
});

t("formatMomentRelative is defensive against bad input", () => {
  assert.equal(formatMomentRelative("", Date.now()), "");
  assert.equal(formatMomentRelative("not-a-date", Date.now()), "");
  // future timestamps return "scheduled"
  const now = Date.parse("2026-04-26T12:00:00Z");
  assert.equal(formatMomentRelative("2026-04-27T12:00:00Z", now), "scheduled");
});

t("formatMomentExpiry returns null for past or missing deadlines", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  assert.equal(formatMomentExpiry(null, now), null);
  assert.equal(formatMomentExpiry("2026-04-25T12:00:00Z", now), null);
  assert.equal(formatMomentExpiry("not-a-date", now), null);
});

t("formatMomentExpiry produces hours-then-days format", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  assert.equal(formatMomentExpiry("2026-04-26T15:00:00Z", now), "expires in 3h");
  assert.equal(formatMomentExpiry("2026-04-28T12:00:00Z", now), "expires in 2d");
  assert.equal(formatMomentExpiry("2026-04-26T12:30:00Z", now), "expires soon");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
