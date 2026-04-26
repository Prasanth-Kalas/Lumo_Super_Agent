/**
 * Admin intelligence pure-core tests.
 *
 * Run: node --experimental-strip-types tests/admin-stats.test.mjs
 */

import assert from "node:assert/strict";
import {
  formatAnomalyFinding,
  formatProactiveMoment,
  interpretBrainHealth,
  percentile,
  summarizeBrainToolUsage,
  summarizeCronRuns,
} from "../lib/admin-stats-core.ts";

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

console.log("\nadmin intelligence stats");

await t("summarizeCronRuns with empty array returns empty array", () => {
  assert.deepEqual(summarizeCronRuns([]), []);
  // Non-array input is also defensively handled.
  assert.deepEqual(summarizeCronRuns(/** @type {any} */ (null)), []);
});

await t(
  "summarizeCronRuns with mixed ok/fail rows computes counts and p95",
  () => {
    const rows = [
      {
        endpoint: "/api/cron/proactive-scan",
        finished_at: "2026-04-26T10:00:00.000Z",
        ok: true,
        latency_ms: 100,
      },
      {
        endpoint: "/api/cron/proactive-scan",
        finished_at: "2026-04-26T11:00:00.000Z",
        ok: true,
        latency_ms: 200,
      },
      {
        endpoint: "/api/cron/proactive-scan",
        finished_at: "2026-04-26T12:00:00.000Z",
        ok: false,
        latency_ms: 5000,
      },
      {
        endpoint: "/api/cron/index-archive",
        finished_at: "2026-04-26T09:00:00.000Z",
        ok: true,
        latency_ms: 50,
      },
    ];
    const out = summarizeCronRuns(rows);
    const proactive = out.find(
      (r) => r.endpoint === "/api/cron/proactive-scan",
    );
    assert.ok(proactive, "expected proactive-scan row");
    assert.equal(proactive.ok_count_24h, 2);
    assert.equal(proactive.fail_count_24h, 1);
    // p50 of [100,200,5000] = 200; p95 dominated by 5000 outlier.
    assert.equal(proactive.latency_p50_ms, 200);
    assert.ok(
      proactive.latency_p95_ms !== null && proactive.latency_p95_ms >= 4000,
      `p95 should reflect the slow run, got ${proactive.latency_p95_ms}`,
    );
    // last_run_at picks the latest finished_at.
    assert.equal(proactive.last_run_at, "2026-04-26T12:00:00.000Z");

    const archive = out.find((r) => r.endpoint === "/api/cron/index-archive");
    assert.ok(archive);
    assert.equal(archive.ok_count_24h, 1);
    assert.equal(archive.fail_count_24h, 0);
  },
);

await t("summarizeBrainToolUsage filters non-lumo-ml rows out", () => {
  const rows = [
    {
      agent_id: "lumo-ml",
      tool_name: "lumo_transcribe",
      ok: true,
      latency_ms: 800,
    },
    {
      agent_id: "lumo-ml",
      tool_name: "lumo_transcribe",
      ok: false,
      latency_ms: 1200,
    },
    {
      agent_id: "lumo-ml",
      tool_name: "lumo_run_python_sandbox",
      ok: true,
      latency_ms: 300,
    },
    // These should be filtered out — different agent.
    {
      agent_id: "partner:flights",
      tool_name: "search_flights",
      ok: true,
      latency_ms: 200,
    },
    {
      agent_id: "open-maps",
      tool_name: "route",
      ok: true,
      latency_ms: 150,
    },
  ];
  const out = summarizeBrainToolUsage(rows);
  const tools = out.map((r) => r.tool_name).sort();
  assert.deepEqual(tools, ["lumo_run_python_sandbox", "lumo_transcribe"]);
  const transcribe = out.find((r) => r.tool_name === "lumo_transcribe");
  assert.ok(transcribe);
  assert.equal(transcribe.call_count_24h, 2);
  assert.equal(transcribe.ok_rate_24h, 0.5);
  assert.ok(transcribe.latency_p95_ms >= 800);
});

await t("formatProactiveMoment truncates body at 120 chars", () => {
  const longBody = "x".repeat(500);
  const row = {
    id: "m_123",
    user_id: "u_1",
    moment_type: "anomaly_alert",
    urgency: "high",
    status: "pending",
    title: "Spike in revenue",
    body: longBody,
    created_at: "2026-04-26T10:00:00.000Z",
  };
  const nowMs = Date.parse("2026-04-26T10:01:30.000Z");
  const out = formatProactiveMoment(row, nowMs);
  assert.ok(out, "expected a non-null formatted row");
  assert.equal(out.body_excerpt.length, 120);
  assert.equal(out.body_excerpt, "x".repeat(120));
  // Age = 90s.
  assert.equal(out.age_seconds, 90);
  assert.equal(out.urgency, "high");
});

await t("interpretBrainHealth(null, ...) returns status=unreachable", () => {
  const fetched = "2026-04-26T10:00:00.000Z";
  const nowMs = Date.parse("2026-04-26T10:00:00.500Z");
  const snap = interpretBrainHealth(null, fetched, nowMs);
  assert.equal(snap.status, "unreachable");
  assert.equal(snap.service_jwt, "missing");
  assert.equal(snap.sandbox, "unconfigured");
  assert.equal(snap.modal, "unconfigured");
  assert.equal(snap.fetched_at, fetched);
  assert.equal(snap.age_ms, 500);
});

await t(
  "interpretBrainHealth returns degraded when any upstream is degraded",
  () => {
    const fetched = "2026-04-26T10:00:00.000Z";
    const nowMs = Date.parse("2026-04-26T10:00:00.000Z");
    // Top says ok, but sandbox upstream reports degraded → overall degraded.
    const snap = interpretBrainHealth(
      {
        status: "ok",
        upstream: {
          service_jwt: { status: "ok" },
          sandbox: {
            status: "degraded",
            last_error: "E2B/Firecracker runtime is not configured",
          },
          modal_whisper: { status: "ok" },
        },
      },
      fetched,
      nowMs,
    );
    assert.equal(snap.status, "degraded");
    assert.equal(snap.service_jwt, "ok");
    // "not configured" in last_error → unconfigured (not "degraded").
    assert.equal(snap.sandbox, "unconfigured");
    assert.equal(snap.modal, "ok");
  },
);

// Bonus: percentile sanity — guards regressions in the helper itself.
await t("percentile handles empty / single / interpolated cases", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([42], 0.5), 42);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
