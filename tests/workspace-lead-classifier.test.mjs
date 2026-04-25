/**
 * Workspace lead classifier scoring helpers.
 *
 * Run: node --experimental-strip-types tests/workspace-lead-classifier.test.mjs
 */

import assert from "node:assert/strict";
import { mergeMlLeadScore, scoreLeadHeuristic } from "../lib/lead-scoring.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

console.log("\nworkspace lead classifier scoring");

await t("heuristic fallback scores obvious business leads", () => {
  const lead = scoreLeadHeuristic("We want to sponsor your next video. Email partnerships@example.com.");
  assert.equal(lead.source, "heuristic");
  assert.ok(lead.score >= 0.7);
  assert.ok(lead.reasons.includes("sponsorship"));
});

await t("ML response overrides fallback scores without losing shape", () => {
  const fallback = scoreLeadHeuristic("Nice video!");
  const merged = mergeMlLeadScore(fallback, {
    label: "business_lead",
    score: 0.88,
    reasons: ["speaker-invite"],
    above_threshold: true,
  });
  assert.deepEqual(merged, {
    score: 0.88,
    reasons: ["speaker-invite"],
    source: "ml",
  });
});

await t("malformed ML response keeps heuristic fallback", () => {
  const fallback = scoreLeadHeuristic(
    "We want to sponsor your next video and partner on launch. Email partnerships@example.com.",
  );
  const merged = mergeMlLeadScore(fallback, { label: "business_lead", reasons: ["bad-shape"] });
  assert.equal(merged.source, "heuristic");
  assert.ok(merged.score >= 0.7);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
