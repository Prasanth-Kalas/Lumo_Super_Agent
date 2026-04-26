/**
 * Metric insight orchestration tests.
 *
 * Run: node --experimental-strip-types tests/metric-insights.test.mjs
 */

import assert from "node:assert/strict";
import {
  answerMetricInsightCore,
  formatMetricInsightAnswer,
  shouldRunMetricInsight,
} from "../lib/metric-insights-core.ts";
import { detectAnomalyFallback } from "../lib/anomaly-detection-core.ts";
import { forecastMetricFallback } from "../lib/forecasting-core.ts";

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

console.log("\nmetric insights");

await t("gate recognizes revenue anomaly questions", () => {
  assert.equal(shouldRunMetricInsight("Why is my Stripe revenue down this week?"), true);
  assert.equal(shouldRunMetricInsight("Book me a flight to Vegas"), false);
});

await t("formats anomaly findings into chat text", () => {
  const answer = formatMetricInsightAnswer(
    "stripe.revenue",
    {
      source: "fallback",
      model: "prophet",
      points_analyzed: 30,
      latency_ms: 0,
      findings: [
        {
          finding_type: "drop",
          anomaly_ts: "2026-01-30T00:00:00.000Z",
          expected_value: 1200,
          actual_value: 700,
          z_score: -4.1,
          confidence: 0.94,
        },
      ],
    },
    null,
  );
  assert.match(answer, /Stripe revenue dropped/);
  assert.match(answer, /Confidence 94%/);
});

await t("answer path routes through anomaly detection over a stub stream", async () => {
  const result = await answerMetricInsightCore({
    user_id: "user_123",
    query: "Why is my Stripe revenue down this week?",
    deps: {
      detectMetricAnomalies: async ({ input }) => detectAnomalyFallback(input),
      forecastMetricForUser: async ({ input }) => forecastMetricFallback(input),
    },
  });
  assert.equal(result.metric_key, "stripe.revenue");
  assert.equal(result.anomaly.source, "fallback");
  assert.ok(result.anomaly.findings.length >= 1);
  assert.match(result.answer, /Stripe revenue dropped/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
