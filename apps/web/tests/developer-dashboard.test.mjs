/**
 * DEV-DASH helper, route, migration, and UI smoke tests.
 *
 * Run: node --experimental-strip-types tests/developer-dashboard.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  buildDeveloperMetricsRollupRows,
  evaluatePromotionEligibility,
  normalizeWebhookEvents,
  stableAuthorUserHash,
} from "../lib/developer-dashboard-core.ts";

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

console.log("\ndeveloper dashboard");

await t("metrics rollup aggregates costs, errors, installs, and capabilities by hour", () => {
  const rows = buildDeveloperMetricsRollupRows({
    costRows: [
      {
        agent_id: "weather-now",
        agent_version: "1.0.0",
        capability_id: "forecast",
        status: "completed",
        cost_usd_total: 0.1,
        cost_usd_developer_share: 0.03,
        evidence: { latency_ms: 120 },
        created_at: "2026-04-29T10:12:00Z",
      },
      {
        agent_id: "weather-now",
        agent_version: "1.0.0",
        capability_id: "forecast",
        status: "aborted_error",
        cost_usd_total: 0.2,
        cost_usd_developer_share: 0.05,
        evidence: { latency_ms: 240 },
        created_at: "2026-04-29T10:34:00Z",
      },
      {
        agent_id: "weather-now",
        agent_version: "1.0.0",
        capability_id: "alerts",
        status: "completed",
        cost_usd_total: 0.3,
        cost_usd_developer_share: 0.1,
        created_at: "2026-04-29T11:01:00Z",
      },
    ],
    installRows: [
      {
        agent_id: "weather-now",
        agent_version: "1.0.0",
        event_type: "install_completed",
        created_at: "2026-04-29T10:05:00Z",
      },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hour, "2026-04-29T10:00:00.000Z");
  assert.equal(rows[0].install_delta, 1);
  assert.equal(rows[0].invocation_count, 2);
  assert.equal(rows[0].error_count, 1);
  assert.equal(rows[0].total_cost_usd, 0.3);
  assert.equal(rows[0].developer_share_usd, 0.08);
  assert.equal(rows[0].p95_latency_ms, 240);
  assert.equal(rows[0].top_capabilities[0].capability_id, "forecast");
  assert.equal(rows[1].p95_latency_ms, null);
});

await t("promotion eligibility enforces identity tier ladder", () => {
  assert.deepEqual(
    evaluatePromotionEligibility({
      currentTier: "experimental",
      targetTier: "community",
      identityTier: "unverified",
    }),
    { ok: false, reason: "email_verification_required" },
  );
  assert.deepEqual(
    evaluatePromotionEligibility({
      currentTier: "experimental",
      targetTier: "community",
      identityTier: "email_verified",
    }),
    { ok: true, reason: "eligible" },
  );
  assert.deepEqual(
    evaluatePromotionEligibility({
      currentTier: "community",
      targetTier: "verified",
      identityTier: "email_verified",
    }),
    { ok: false, reason: "legal_entity_verification_required" },
  );
  assert.deepEqual(
    evaluatePromotionEligibility({
      currentTier: "verified",
      targetTier: "official",
      identityTier: "legal_entity_verified",
    }),
    { ok: false, reason: "official_is_lumo_only" },
  );
});

await t("author user hashes are stable per author and opaque across authors", () => {
  const a = stableAuthorUserHash("author-a", "user-1");
  assert.equal(a, stableAuthorUserHash("author-a", "user-1"));
  assert.notEqual(a, stableAuthorUserHash("author-b", "user-1"));
  assert.match(a, /^du_[a-f0-9]{16}$/);
});

await t("webhook events are normalized to the allowed DEV-DASH set", () => {
  assert.deepEqual(
    normalizeWebhookEvents(["install_completed", "install_completed", "bad"]),
    ["install_completed"],
  );
  assert.deepEqual(normalizeWebhookEvents(null), [
    "install_completed",
    "uninstall_completed",
  ]);
});

await t("migration 040 carries rollback, author-scoped RLS, and security-invoker view", () => {
  const sql = readFileSync(
    new URL("../../../db/migrations/040_dev_dash.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /drop table if exists public\.developer_agent_metrics_hourly/i);
  assert.match(sql, /developer_agents_view\s*\nwith\s*\(security_invoker\s*=\s*true\)/i);
  assert.match(sql, /lower\(coalesce\(ma\.author_email,\s*''\)\)\s*=\s*lower\(coalesce\(p\.email,\s*''\)\)/i);
  assert.match(sql, /developer_promotion_requests_one_pending/i);
  assert.match(sql, /DEVELOPER_PROMOTION_DECISION_IMMUTABLE/);
});

await t("API surface exposes author reads, promotion validation, webhook edit, and rollup cron", () => {
  const files = {
    agents: "../app/api/developer/agents/route.ts",
    metrics: "../app/api/developer/agents/[agent_id]/metrics/route.ts",
    promotion: "../app/api/developer/promotion-requests/route.ts",
    webhooks: "../app/api/developer/webhooks/route.ts",
    cron: "../app/api/cron/developer-metrics-rollup/route.ts",
  };
  for (const [name, file] of Object.entries(files)) {
    assert.ok(existsSync(new URL(file, import.meta.url)), `${name} route missing`);
  }
  const promotion = readFileSync(new URL(files.promotion, import.meta.url), "utf8");
  const webhooks = readFileSync(new URL(files.webhooks, import.meta.url), "utf8");
  const cron = readFileSync(new URL(files.cron, import.meta.url), "utf8");
  assert.match(promotion, /invalid_target_tier/);
  assert.match(webhooks, /export async function PATCH/);
  assert.match(cron, /runDeveloperMetricsRollup/);
  assert.match(cron, /recordCronRun/);
});

await t("developer UI pages redirect without auth and include requested scaffolding", () => {
  const pages = [
    ["dashboard", "../app/developer/dashboard/page.tsx", "/login?next=/developer/dashboard"],
    ["agents", "../app/developer/agents/page.tsx", "/login?next=/developer/agents"],
    ["agent detail", "../app/developer/agents/[agent_id]/page.tsx", "/login?next=/developer/agents/"],
    ["submissions", "../app/developer/submissions/page.tsx", "/login?next=/developer/submissions"],
    ["identity", "../app/developer/identity-verification/page.tsx", "/login?next=/developer/identity-verification"],
    ["promotion", "../app/developer/promotion-requests/page.tsx", "/login?next=/developer/promotion-requests"],
    ["webhooks", "../app/developer/webhooks/page.tsx", "/login?next=/developer/webhooks"],
  ];
  for (const [name, file, redirect] of pages) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /getServerUser/);
    assert.match(source, new RegExp(escapeRegExp(redirect)));
    assert.match(source, /PageHeading|DeveloperIndexPage/);
    assert.ok(source.length > 500, `${name} page looks under-scaffolded`);
  }
  const detail = readFileSync(
    new URL("../app/developer/agents/[agent_id]/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(detail, /Latency data collection begins Phase 5|LatencyPanel/);
});

await t("Vercel and ops configs register the developer metrics cron", () => {
  const appVercel = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
  const rootVercel = readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8");
  const ops = readFileSync(new URL("../lib/ops.ts", import.meta.url), "utf8");
  for (const source of [appVercel, rootVercel, ops]) {
    assert.match(source, /developer-metrics-rollup/);
  }
});

if (fail > 0) {
  console.error(`\n${fail} developer dashboard test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} developer dashboard test(s) passed`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
