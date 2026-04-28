/**
 * Proactive moments API-shape tests.
 *
 * Run: node --experimental-strip-types tests/proactive-moments.test.mjs
 */

import assert from "node:assert/strict";
import {
  normalizeMomentActionBody,
  normalizeProactiveMomentRows,
} from "../lib/proactive-moments-core.ts";

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

console.log("\nproactive moments");

t("normalizes valid rows and sorts high urgency first", () => {
  const rows = [
    {
      id: "low_1",
      moment_type: "opportunity",
      title: "Low",
      body: "A small opportunity.",
      evidence: { source: "test" },
      urgency: "low",
      valid_from: "2026-04-26T10:00:00.000Z",
      valid_until: null,
      created_at: "2026-04-26T10:00:00.000Z",
    },
    {
      id: "high_1",
      moment_type: "anomaly_alert",
      title: "High",
      body: "Revenue dropped.",
      evidence: { source: "test" },
      urgency: "high",
      valid_from: "2026-04-26T09:00:00.000Z",
      valid_until: "2026-04-27T09:00:00.000Z",
      created_at: "2026-04-26T09:00:00.000Z",
    },
  ];
  const moments = normalizeProactiveMomentRows(rows);
  assert.equal(moments.length, 2);
  assert.equal(moments[0].id, "high_1");
  assert.equal(moments[0].valid_until, "2026-04-27T09:00:00.000Z");
});

t("drops malformed rows instead of throwing", () => {
  const moments = normalizeProactiveMomentRows([
    { id: "missing-type", title: "Nope" },
    "broken",
    null,
  ]);
  assert.deepEqual(moments, []);
});

t("normalizes PATCH action bodies", () => {
  assert.equal(normalizeMomentActionBody({ status: "acted_on" }), "acted_on");
  assert.equal(normalizeMomentActionBody({ action: "dismiss" }), "dismissed");
  assert.equal(normalizeMomentActionBody({ status: "pending" }), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
