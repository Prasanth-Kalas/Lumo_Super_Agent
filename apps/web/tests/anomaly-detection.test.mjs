/**
 * Anomaly detection pure-core tests.
 *
 * Run: node --experimental-strip-types tests/anomaly-detection.test.mjs
 */

import assert from "node:assert/strict";
import {
  detectAnomalyCore,
  detectAnomalyFallback,
  normalizeDetectAnomalyResponse,
} from "../lib/anomaly-detection-core.ts";

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

console.log("\nanomaly detection");

await t("fallback detects a revenue drop", () => {
  const input = {
    metric_key: "stripe.revenue",
    points: series({ dropOnLast: true }),
    context: { expected_frequency: "daily", min_points: 14 },
  };
  const result = detectAnomalyFallback(input);
  assert.equal(result.source, "fallback");
  assert.equal(result.findings[0]?.finding_type, "drop");
  assert.ok((result.findings[0]?.confidence ?? 0) > 0.8);
});

await t("uses ML response when the brain returns valid findings", async () => {
  const result = await detectAnomalyCore({
    input: { metric_key: "stripe.revenue", points: series({}), context: { min_points: 14 } },
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () =>
      Response.json({
        model: "prophet",
        points_analyzed: 30,
        findings: [
          {
            finding_type: "drop",
            anomaly_ts: "2026-01-30T00:00:00.000Z",
            expected_value: 1000,
            actual_value: 620,
            z_score: -4.2,
            confidence: 0.96,
          },
        ],
      }),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "ml");
  assert.equal(result.findings[0]?.confidence, 0.96);
});

await t("timeout falls back with the timeout error", async () => {
  const result = await detectAnomalyCore({
    input: { metric_key: "stripe.revenue", points: series({}), context: { min_points: 14 } },
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    timeoutMs: 10,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.error, "timeout");
});

await t("malformed response degrades without throwing", () => {
  const result = normalizeDetectAnomalyResponse(
    { model: "prophet", points_analyzed: 12, findings: "broken" },
    42,
  );
  assert.equal(result, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function series({ dropOnLast = false }) {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: 30 }, (_, index) => ({
    ts: new Date(start + index * 24 * 60 * 60 * 1000).toISOString(),
    value: dropOnLast && index === 29 ? 610 : 1000 + (index % 7) * 10,
  }));
}
