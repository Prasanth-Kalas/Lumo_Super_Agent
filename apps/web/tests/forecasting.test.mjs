/**
 * Forecasting pure-core tests.
 *
 * Run: node --experimental-strip-types tests/forecasting.test.mjs
 */

import assert from "node:assert/strict";
import {
  forecastMetricCore,
  forecastMetricFallback,
  normalizeForecastMetricResponse,
} from "../lib/forecasting-core.ts";

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

console.log("\nforecasting");

await t("fallback tracks weekly seasonality", () => {
  const points = weeklySeries();
  const result = forecastMetricFallback({
    metric_key: "hotel.price",
    points,
    horizon_days: 14,
    context: { expected_frequency: "daily" },
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.model, "naive_seasonal");
  assert.equal(result.forecast.length, 14);
  const expected = Array.from({ length: 14 }, (_, index) => points[points.length - 7 + (index % 7)].value);
  const mape =
    result.forecast.reduce(
      (sum, point, index) => sum + Math.abs(point.predicted_value - expected[index]) / expected[index],
      0,
    ) / expected.length;
  assert.ok(mape < 0.15);
});

await t("uses ML response when the brain returns a valid forecast", async () => {
  const result = await forecastMetricCore({
    input: { metric_key: "hotel.price", points: weeklySeries(), horizon_days: 2 },
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () =>
      Response.json({
        model: "prophet",
        confidence_interval: 0.8,
        points_used: 30,
        forecast: [
          {
            ts: "2026-02-01T00:00:00.000Z",
            predicted_value: 180,
            lower_bound: 150,
            upper_bound: 210,
          },
        ],
      }),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "ml");
  assert.equal(result.model, "prophet");
  assert.equal(result.forecast[0]?.predicted_value, 180);
});

await t("HTTP failure falls back", async () => {
  const result = await forecastMetricCore({
    input: { metric_key: "hotel.price", points: weeklySeries(), horizon_days: 3 },
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () => new Response("nope", { status: 503 }),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.error, "http_503");
});

await t("malformed response degrades without throwing", () => {
  const result = normalizeForecastMetricResponse(
    { model: "prophet", confidence_interval: 0.8, points_used: 30, forecast: "broken" },
    42,
  );
  assert.equal(result, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function weeklySeries() {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const pattern = [100, 120, 140, 160, 180, 220, 200];
  return Array.from({ length: 90 }, (_, index) => ({
    ts: new Date(start + index * 24 * 60 * 60 * 1000).toISOString(),
    value: pattern[index % 7],
  }));
}
