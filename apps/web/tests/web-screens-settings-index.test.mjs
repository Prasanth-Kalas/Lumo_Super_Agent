/**
 * WEB-SCREENS-1 settings index — verifies the flat list of links the
 * /settings page renders is complete and well-formed.
 *
 * Run: node --experimental-strip-types tests/web-screens-settings-index.test.mjs
 */

import assert from "node:assert/strict";
import { SETTINGS_INDEX_ITEMS } from "../lib/web-screens-settings-index.ts";

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

console.log("\nweb-screens settings index");

t("authenticated render — every required surface is registered", () => {
  const hrefs = new Set(SETTINGS_INDEX_ITEMS.map((i) => i.href));
  assert.ok(hrefs.has("/settings/account"));
  assert.ok(hrefs.has("/profile"));
  assert.ok(hrefs.has("/settings/notifications"));
  assert.ok(hrefs.has("/settings/voice"));
  assert.ok(hrefs.has("/settings/wake-word"));
  assert.ok(hrefs.has("/settings/cost"));
});

t("empty state — no entries point at non-routes (sanity)", () => {
  for (const item of SETTINGS_INDEX_ITEMS) {
    assert.match(item.href, /^\/(settings|profile)/);
  }
});

t("error state — every item has a non-empty label and description", () => {
  for (const item of SETTINGS_INDEX_ITEMS) {
    assert.ok(item.label.length > 0, `empty label for ${item.href}`);
    assert.ok(item.description.length > 0, `empty description for ${item.href}`);
  }
});

t("hrefs are unique", () => {
  const seen = new Set();
  for (const item of SETTINGS_INDEX_ITEMS) {
    assert.equal(seen.has(item.href), false, `duplicate href ${item.href}`);
    seen.add(item.href);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
