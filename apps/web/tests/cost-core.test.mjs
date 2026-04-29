/**
 * COST-1 pure helper + migration contract tests.
 *
 * Run: node --experimental-strip-types tests/cost-core.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCostLogRow,
  buildCostRollupRows,
  chooseFallbackModel,
  deterministicUuid,
  digestBody,
  evaluateBudgetCap,
  extractInvocationCostActuals,
} from "../lib/cost-core.ts";

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

console.log("\ncost core");

await t("budget check allows projected cost exactly equal to cap", () => {
  const result = evaluateBudgetCap({
    userId: "user-1",
    projectedCostUsd: 0.05,
    manifestMaxCostUsd: 0.05,
    userGrantMaxCostUsd: 0.06,
    dailyCapUsd: 1,
    dailySpendUsd: 0.95,
    monthlyCapUsd: 10,
    monthlySpendUsd: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.projectedCostUsd, 0.05);
  assert.equal(result.capUsd, 0.05);
});

await t("null caps do not reject budget checks", () => {
  const result = evaluateBudgetCap({
    userId: "user-1",
    projectedCostUsd: 12,
    manifestMaxCostUsd: null,
    userGrantMaxCostUsd: null,
    dailyCapUsd: null,
    dailySpendUsd: 500,
    monthlyCapUsd: null,
    monthlySpendUsd: 5_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.capUsd, null);
  assert.equal(result.remainingDailyUsd, null);
  assert.equal(result.remainingMonthlyUsd, null);
});

await t("hard daily and per-invocation caps deny with structured reasons", () => {
  const perInvocation = evaluateBudgetCap({
    userId: "user-1",
    projectedCostUsd: 0.11,
    manifestMaxCostUsd: 0.1,
  });
  assert.equal(perInvocation.ok, false);
  assert.equal(perInvocation.reason, "per_invocation_cap_exceeded");

  const daily = evaluateBudgetCap({
    userId: "user-1",
    projectedCostUsd: 1,
    dailyCapUsd: 5,
    dailySpendUsd: 4.5,
    monthlyCapUsd: 50,
    monthlySpendUsd: 4.5,
  });
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, "daily_budget_exceeded");
});

await t("soft caps allow but preserve budget evidence", () => {
  const result = evaluateBudgetCap({
    userId: "user-1",
    projectedCostUsd: 1,
    dailyCapUsd: 5,
    dailySpendUsd: 4.5,
    monthlyCapUsd: 50,
    monthlySpendUsd: 4.5,
    softCap: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.forecast_source, "daily_soft_cap_exceeded");
  assert.equal(result.remainingDailyUsd, 0.5);
});

await t("persistence failures fail closed for authenticated users", () => {
  const result = evaluateBudgetCap({
    userId: "user-1",
    projectedCostUsd: 0.02,
    persistenceAvailable: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "persistence_unavailable");
  assert.equal(result.evidence.budget_code, "PERSISTENCE_UNAVAILABLE");
});

await t("ledger rows normalize retry ids and preserve source request id", () => {
  const row = buildCostLogRow({
    requestId: "req-123",
    userId: "user-1",
    agentId: "weather-now",
    agentVersion: "1.0.0",
    costUsdTotal: 0.03,
    costUsdDeveloperShare: 0.01,
  });
  assert.match(String(row.request_id), /^[0-9a-f-]{36}$/);
  assert.equal(row.cost_usd_platform, 0.02);
  assert.deepEqual(row.evidence, {
    fallback_model_used: false,
    original_request_id: "req-123",
  });
  assert.equal(deterministicUuid("req-123"), row.request_id);
});

await t("actual costs prefer agent cost_actuals and mark fallback usage", () => {
  const actual = extractInvocationCostActuals(
    {
      cost_actuals: {
        total_usd: 0.12,
        developer_share_usd: 0.03,
        prompt_tokens: 100,
        completion_tokens: 50,
        model_used: "claude-haiku-4-6",
        fallback_model_used: "claude-haiku-4-6",
      },
    },
    {
      manifest: {},
      routing: { cost_tier: "metered" },
      forecast: {
        projectedCostUsd: 0.4,
        maxCostUsdPerInvocation: 1,
        modelUsed: "claude-sonnet-4-6",
        forecastSource: "manifest_cost_model",
      },
      status: "completed",
    },
  );
  assert.equal(actual.costUsdTotal, 0.12);
  assert.equal(actual.costUsdPlatform, 0.09);
  assert.equal(actual.evidence.actual_source, "agent_cost_actuals");
  assert.equal(actual.evidence.fallback_model_used, "claude-haiku-4-6");
});

await t("aborted calls without result record zero cost", () => {
  const actual = extractInvocationCostActuals(null, {
    manifest: {},
    routing: { cost_tier: "metered" },
    forecast: {
      projectedCostUsd: 0.4,
      maxCostUsdPerInvocation: 1,
      modelUsed: "claude-sonnet-4-6",
      forecastSource: "manifest_cost_model",
    },
    status: "aborted_budget",
  });
  assert.equal(actual.costUsdTotal, 0);
  assert.equal(actual.evidence.actual_source, "no_result");
});

await t("fallback model selection lowers expensive model classes", () => {
  assert.equal(chooseFallbackModel("claude-opus-4-6"), "claude-haiku-4-6");
  assert.equal(chooseFallbackModel("claude-sonnet-4-6"), "claude-haiku-4-6");
  assert.equal(chooseFallbackModel("claude-haiku-4-6"), null);
});

await t("rollups aggregate by user with budget aborts and fallback counts", () => {
  const rows = buildCostRollupRows(
    [
      {
        user_id: "user-a",
        agent_id: "weather-now",
        capability_id: "forecast",
        cost_usd_total: 0.1,
        cost_usd_platform: 0.08,
        cost_usd_developer_share: 0.02,
        prompt_tokens: 10,
        completion_tokens: 5,
        status: "completed",
        evidence: { fallback_model_used: "claude-haiku-4-6" },
      },
      {
        user_id: "user-a",
        agent_id: "trip-planner",
        capability_id: "book",
        cost_usd_total: 0.2,
        cost_usd_platform: 0.2,
        cost_usd_developer_share: 0,
        status: "aborted_budget",
      },
      {
        user_id: "user-b",
        agent_id: "weather-now",
        cost_usd_total: 0.05,
      },
    ],
    {
      start: new Date("2026-04-01T00:00:00Z"),
      end: new Date("2026-04-02T00:00:00Z"),
    },
  );
  const userA = rows.find((row) => row.user_id === "user-a");
  assert.ok(userA);
  assert.equal(userA.invocation_count, 2);
  assert.equal(userA.aborted_budget_count, 1);
  assert.equal(userA.fallback_count, 1);
  assert.equal(userA.cost_usd_total, 0.3);
  assert.equal(userA.top_agents[0].agent_id, "trip-planner");
  assert.equal(userA.capability_breakdown.book.total_usd, 0.2);
});

await t("digest body is stable and singularizes one invocation", () => {
  assert.equal(
    digestBody("daily", 0.1, 1, [{ agent_id: "weather-now" }]),
    "Your daily Lumo agent spend was $0.10 across 1 invocation. Top agent: weather-now.",
  );
});

await t("migration and library keep digest delivery idempotent", () => {
  const migration = readFileSync(
    new URL("../../../db/migrations/039_cost_1_metering_budgets.sql", import.meta.url),
    "utf8",
  );
  const costLib = readFileSync(new URL("../lib/cost.ts", import.meta.url), "utf8");
  assert.match(migration, /unique\s*\(request_id\)/i);
  assert.match(migration, /primary key\s*\(user_id,\s*digest_type,\s*period_start\)/i);
  assert.match(costLib, /onConflict:\s*"user_id,digest_type,period_start"/);
});

if (fail > 0) {
  console.error(`\n${fail} cost core test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} cost core test(s) passed`);
