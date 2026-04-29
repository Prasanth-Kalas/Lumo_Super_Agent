import assert from "node:assert/strict";
import { checkTyposquat, levenshtein } from "../lib/marketplace/typosquatting.ts";
import { signatureRequirementError } from "../lib/marketplace/submission-policy.ts";
import {
  latestPatchFromRows,
  nearestPatchFromRows,
} from "../lib/marketplace/version-policy.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log("\nmarketplace submission + versioning");

await t("reserved marketplace prefixes are rejected", () => {
  assert.deepEqual(
    checkTyposquat("lumo-calendar", []),
    { ok: false, reason: "reserved_prefix" },
  );
});

await t("near-neighbour official agent ids are rejected", () => {
  assert.deepEqual(
    checkTyposquat("googl", [{ agent_id: "google", trust_tier: "official" }]),
    { ok: false, reason: "near_official", neighbor: "google" },
  );
  assert.equal(levenshtein("googl", "google"), 1);
});

await t("verified and official submissions require signatures before DB writes", async () => {
  assert.equal(signatureRequirementError("verified", null), "signature_required");
  assert.equal(signatureRequirementError("official", " "), "signature_required");
  assert.equal(signatureRequirementError("community", null), null);
  assert.equal(signatureRequirementError("experimental", null), null);
  assert.equal(signatureRequirementError("verified", "sig_ed25519_abc"), null);
});

await t("version sync selects same-minor non-yanked patches", () => {
  const rows = [
    { version: "1.2.0", published_at: "2026-01-01T00:00:00Z", yanked: true },
    { version: "1.2.1", published_at: "2026-01-02T00:00:00Z", yanked: false },
    { version: "1.2.2", published_at: "2026-01-03T00:00:00Z", yanked: false },
    { version: "1.3.0", published_at: "2026-01-04T00:00:00Z", yanked: false },
  ];
  assert.equal(
    nearestPatchFromRows(rows, "1.2.0")?.version,
    "1.2.2",
  );
  assert.equal(
    latestPatchFromRows(rows, "1.2.1")?.version,
    "1.2.2",
  );
  assert.equal(
    latestPatchFromRows(rows, "1.3.0"),
    null,
  );
});

if (fail > 0) {
  console.error(`\n${fail} marketplace submission test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} marketplace submission test(s) passed`);
