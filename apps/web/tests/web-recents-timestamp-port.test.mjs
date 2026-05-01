/**
 * WEB-RECENTS-TIMESTAMP-PORT-1 — compact recents timestamps.
 *
 * Run: node --experimental-strip-types tests/web-recents-timestamp-port.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatTimeSince } from "../lib/format-time-since.ts";

const LEFT_RAIL_SRC = readFileSync(
  new URL("../components/LeftRail.tsx", import.meta.url),
  "utf8",
);
const MOBILE_NAV_SRC = readFileSync(
  new URL("../components/MobileNav.tsx", import.meta.url),
  "utf8",
);
const now = new Date("2026-05-02T12:00:00.000Z");

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

function ago(ms) {
  return new Date(now.getTime() - ms);
}

console.log("\nweb recents timestamp port");

t("formats just-now and future timestamps as now", () => {
  assert.equal(formatTimeSince(ago(0), now), "now");
  assert.equal(formatTimeSince(ago(4_900), now), "now");
  assert.equal(formatTimeSince(new Date(now.getTime() + 60_000), now), "now");
});

t("formats sub-minute timestamps as seconds", () => {
  assert.equal(formatTimeSince(ago(5_000), now), "5 sec");
  assert.equal(formatTimeSince(ago(59_999), now), "59 sec");
});

t("formats minute-only timestamps without zero seconds", () => {
  assert.equal(formatTimeSince(ago(5 * 60_000), now), "5 min");
});

t("formats minute-plus-second timestamps", () => {
  assert.equal(formatTimeSince(ago(12 * 60_000 + 3_000), now), "12 min, 3 sec");
});

t("formats hour-only timestamps without zero minutes", () => {
  assert.equal(formatTimeSince(ago(3 * 3_600_000), now), "3 hr");
});

t("formats hour-plus-minute timestamps", () => {
  assert.equal(formatTimeSince(ago(4 * 3_600_000 + 8 * 60_000), now), "4 hr, 8 min");
});

t("formats singular day-plus-hour timestamps", () => {
  assert.equal(formatTimeSince(ago(26 * 3_600_000), now), "1 day, 2 hr");
});

t("formats plural day-only timestamps", () => {
  assert.equal(formatTimeSince(ago(2 * 24 * 3_600_000), now), "2 days");
});

t("LeftRail renders the timestamp subtitle from last_activity_at", () => {
  assert.match(LEFT_RAIL_SRC, /formatTimeSince\(s\.last_activity_at\)/);
  assert.match(LEFT_RAIL_SRC, /text-lumo-fg-low/);
});

t("MobileNav fetches and renders last_activity_at timestamps", () => {
  assert.match(MOBILE_NAV_SRC, /last_activity_at: string/);
  assert.match(MOBILE_NAV_SRC, /formatTimeSince\(s\.last_activity_at\)/);
  assert.match(MOBILE_NAV_SRC, /text-lumo-fg-low/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
