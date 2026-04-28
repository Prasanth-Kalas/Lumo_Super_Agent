import assert from "node:assert/strict";
import {
  confidenceLabel,
  confidenceTone,
  formatMemoryRelative,
  memoryHealthSummary,
  memorySourceDescription,
  memorySourceLabel,
} from "../lib/memory-ui.ts";

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

console.log("\nmemory UI helpers");

t("source labels are user-facing", () => {
  assert.equal(memorySourceLabel("explicit"), "Told by you");
  assert.equal(memorySourceLabel("inferred"), "Inferred");
  assert.equal(memorySourceLabel("behavioral"), "Learned from activity");
  assert.equal(memorySourceLabel("custom_source"), "Custom Source");
});

t("source descriptions explain provenance", () => {
  assert.ok(memorySourceDescription("explicit").includes("user-provided"));
  assert.ok(memorySourceDescription("inferred").includes("conversation"));
  assert.ok(memorySourceDescription("behavioral").includes("actions"));
});

t("confidence tone buckets are stable", () => {
  assert.equal(confidenceTone(0.9), "high");
  assert.equal(confidenceTone(0.7), "medium");
  assert.equal(confidenceTone(0.2), "low");
});

t("confidence labels clamp out-of-range values", () => {
  assert.equal(confidenceLabel(1.2), "100% confidence");
  assert.equal(confidenceLabel(-1), "0% needs review");
});

t("relative dates are compact and deterministic", () => {
  const now = Date.parse("2026-04-28T12:00:00Z");
  assert.equal(formatMemoryRelative("2026-04-28T11:59:30Z", now), "just now");
  assert.equal(formatMemoryRelative("2026-04-28T11:10:00Z", now), "50m ago");
  assert.equal(formatMemoryRelative("2026-04-28T02:00:00Z", now), "10h ago");
  assert.equal(formatMemoryRelative("2026-04-27T10:00:00Z", now), "yesterday");
  assert.equal(formatMemoryRelative("2026-04-18T12:00:00Z", now), "10d ago");
  assert.equal(formatMemoryRelative("2025-05-03T12:00:00Z", now), "12mo ago");
});

t("health summary names important memory counts", () => {
  assert.equal(
    memoryHealthSummary({
      factCount: 0,
      highConfidenceCount: 0,
      inferredCount: 0,
      patternCount: 0,
    }),
    "No saved memories yet",
  );
  assert.equal(
    memoryHealthSummary({
      factCount: 4,
      highConfidenceCount: 3,
      inferredCount: 1,
      patternCount: 2,
    }),
    "4 facts · 3 high confidence · 1 inferred · 2 patterns",
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
