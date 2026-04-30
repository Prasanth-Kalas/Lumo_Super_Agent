/**
 * WEB-SCREENS-1 profile editor helpers.
 *
 * Run: node --experimental-strip-types tests/web-screens-profile.test.mjs
 */

import assert from "node:assert/strict";
import {
  AIRLINE_CLASS_OPTIONS,
  buildProfilePatch,
  formatTagList,
  parseTagList,
} from "../lib/web-screens-profile.ts";

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

console.log("\nweb-screens profile helpers");

t("authenticated render — option lists include sentinels and real values", () => {
  const values = AIRLINE_CLASS_OPTIONS.map((o) => o.value);
  assert.ok(values.includes(""));
  assert.ok(values.includes("business"));
});

t("parseTagList trims, dedupes, drops empties", () => {
  assert.deepEqual(parseTagList(" peanut ,Shellfish, peanut, "), ["peanut", "Shellfish"]);
  assert.deepEqual(parseTagList(""), []);
  assert.deepEqual(parseTagList(",,,"), []);
});

t("parseTagList caps at 25 entries", () => {
  const long = Array.from({ length: 40 }, (_, i) => `tag${i}`).join(",");
  assert.equal(parseTagList(long).length, 25);
});

t("formatTagList round-trips", () => {
  assert.equal(formatTagList(["a", "b", "c"]), "a, b, c");
  assert.equal(formatTagList(null), "");
  assert.equal(formatTagList([]), "");
});

t("happy path — buildProfilePatch sends nulls for empty strings", () => {
  const patch = buildProfilePatch({
    display_name: "  Alex  ",
    timezone: "",
    preferred_airline_class: "business",
    preferred_airline_seat: "",
    dietary_flags: "vegetarian, halal",
    allergies: "",
    preferred_cuisines: "japanese,italian",
    preferred_hotel_chains: "",
    budget_tier: "premium",
    preferred_language: "en-US",
  });
  assert.equal(patch.display_name, "Alex");
  assert.equal(patch.timezone, null);
  assert.equal(patch.preferred_airline_class, "business");
  assert.equal(patch.preferred_airline_seat, null);
  assert.deepEqual(patch.dietary_flags, ["vegetarian", "halal"]);
  assert.deepEqual(patch.allergies, []);
  assert.deepEqual(patch.preferred_cuisines, ["japanese", "italian"]);
  assert.deepEqual(patch.preferred_hotel_chains, []);
  assert.equal(patch.budget_tier, "premium");
  assert.equal(patch.preferred_language, "en-US");
});

t("error state — buildProfilePatch ignores unknown keys", () => {
  // @ts-expect-error - unknown_key not on ProfilePatchInput
  const patch = buildProfilePatch({ unknown_key: "haha", display_name: "ok" });
  assert.equal(patch.display_name, "ok");
  assert.equal("unknown_key" in patch, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
