/**
 * Brain Phase 3 readiness helper tests.
 *
 * Run: node --experimental-strip-types tests/brain-capabilities.test.mjs
 */

import assert from "node:assert/strict";
import {
  brainCapabilityCounts,
  brainCapabilitySummary,
  buildBrainCapabilityChecklist,
} from "../lib/brain-capabilities.ts";

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

const endpoint = (name, overrides = {}) => ({
  endpoint: name,
  requests_24h: 10,
  errors_24h: 0,
  error_rate_24h: 0,
  latency_p50_ms: 100,
  latency_p95_ms: 200,
  latency_p99_ms: 300,
  last_seen_at: "2026-04-28T00:00:00.000Z",
  circuit_breaker: {
    endpoint: name,
    state: "closed",
    consecutive_failures: 0,
    opened_at: null,
    half_open_probe_at: null,
  },
  ...overrides,
});

console.log("\nbrain capability readiness");

await t("empty telemetry marks product capabilities pending", () => {
  const out = buildBrainCapabilityChecklist([]);
  assert.equal(out.length, 6);
  assert.equal(out.every((row) => row.status === "pending"), true);
  assert.equal(brainCapabilitySummary(out), "0 ready · 0 watch · 6 pending");
});

await t("matching endpoint traffic marks capability ready", () => {
  const out = buildBrainCapabilityChecklist([
    endpoint("lumo_kg_traverse"),
    endpoint("lumo_kg_synthesize"),
  ]);
  const kg = out.find((row) => row.id === "knowledge_graph");
  assert.ok(kg);
  assert.equal(kg.status, "ready");
  assert.deepEqual(kg.matchedEndpoints, [
    "lumo_kg_traverse",
    "lumo_kg_synthesize",
  ]);
});

await t("elevated errors move a capability to watch", () => {
  const out = buildBrainCapabilityChecklist([
    endpoint("lumo_anomaly_detect", { error_rate_24h: 0.04 }),
  ]);
  const runtime = out.find((row) => row.id === "runtime");
  assert.ok(runtime);
  assert.equal(runtime.status, "watch");
  assert.match(runtime.nextStep, /error rate/i);
});

await t("open breaker takes precedence over ready label", () => {
  const out = buildBrainCapabilityChecklist([
    endpoint("lumo_recall_unified", {
      circuit_breaker: {
        endpoint: "lumo_recall_unified",
        state: "open",
        consecutive_failures: 5,
        opened_at: "2026-04-28T00:00:00.000Z",
        half_open_probe_at: null,
      },
    }),
  ]);
  const mmrag = out.find((row) => row.id === "multimodal");
  assert.ok(mmrag);
  assert.equal(mmrag.status, "watch");
  assert.match(mmrag.nextStep, /breaker is open/);
});

await t("counts summarize readiness buckets", () => {
  const out = buildBrainCapabilityChecklist([
    endpoint("lumo_kg_traverse"),
    endpoint("lumo_voice_clone"),
    endpoint("lumo_recall_unified", { error_rate_24h: 0.05 }),
  ]);
  const counts = brainCapabilityCounts(out);
  assert.equal(counts.total, 6);
  assert.equal(counts.ready, 2); // KG, Voice.
  assert.equal(counts.watch, 2); // MMRAG, Runtime.
  assert.equal(counts.pending, 2); // Bandit, Wake Word.
  assert.equal(brainCapabilitySummary(out), "2 ready · 2 watch · 2 pending");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
