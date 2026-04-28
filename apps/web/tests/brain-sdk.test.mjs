/**
 * Brain SDK implementation tests.
 *
 * Run: node --experimental-strip-types tests/brain-sdk.test.mjs
 */

import assert from "node:assert/strict";
import {
  __resetBrainSdkForTesting,
  createBrainSdkFetch,
} from "../lib/brain-sdk/index.ts";

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

console.log("\nbrain sdk");

await t("retries transient HTTP failures and logs final success", async () => {
  __resetBrainSdkForTesting();
  const rows = [];
  let calls = 0;
  const sdkFetch = createBrainSdkFetch({
    fetchImpl: async () => {
      calls++;
      if (calls < 3) return Response.json({ error: "cold" }, { status: 503 });
      return Response.json({ ok: true });
    },
    telemetrySink: (row) => rows.push(row),
    maxAttempts: 3,
    baseBackoffMs: 1,
    timeoutMs: 500,
    callerSurface: "test",
  });
  const res = await sdkFetch("https://brain.test/api/tools/recall", {
    method: "POST",
    body: JSON.stringify({ query: "hello" }),
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, "lumo_recall");
  assert.equal(rows[0].outcome, "ok");
  assert.equal(rows[0].attempt, 3);
});

await t("opens circuit after configured failures and short-circuits next call", async () => {
  __resetBrainSdkForTesting();
  const rows = [];
  const sdkFetch = createBrainSdkFetch({
    fetchImpl: async () => {
      throw new Error("network down");
    },
    telemetrySink: (row) => rows.push(row),
    maxAttempts: 1,
    failureThreshold: 1,
    timeoutMs: 100,
  });
  await assert.rejects(
    () => sdkFetch("https://brain.test/api/tools/rank_agents", { method: "POST" }),
    /network down/,
  );
  const res = await sdkFetch("https://brain.test/api/tools/rank_agents", { method: "POST" });
  assert.equal(res.status, 503);
  assert.equal(rows.at(-1)?.outcome, "circuit_open");
  assert.equal(rows.at(-1)?.attempt, 0);
});

await t("propagates trace headers without leaking request body", async () => {
  __resetBrainSdkForTesting();
  const rows = [];
  let capturedHeaders = null;
  const sdkFetch = createBrainSdkFetch({
    fetchImpl: async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return Response.json({ ok: true });
    },
    telemetrySink: (row) => rows.push(row),
    maxAttempts: 1,
    timeoutMs: 100,
  });
  await sdkFetch("https://brain.test/api/tools/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts: ["secret body"] }),
  });
  assert.match(capturedHeaders.get("traceparent") ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(capturedHeaders.get("x-lumo-brain-endpoint"), "lumo_embed");
  assert.equal(rows[0].payload_redacted.body_bytes > 0, true);
  assert.equal("texts" in rows[0].payload_redacted, false);
});

await t("maps knowledge-graph synthesis endpoint into telemetry", async () => {
  __resetBrainSdkForTesting();
  const rows = [];
  const sdkFetch = createBrainSdkFetch({
    fetchImpl: async () => Response.json({ answer: "ok" }),
    telemetrySink: (row) => rows.push(row),
    maxAttempts: 1,
    timeoutMs: 100,
  });
  await sdkFetch("https://brain.test/api/kg/synthesize", {
    method: "POST",
    body: JSON.stringify({ question: "why", traversal: [] }),
  });
  assert.equal(rows[0].endpoint, "lumo_kg_synthesize");
});

await t("feature flag can return the legacy fetch implementation", async () => {
  __resetBrainSdkForTesting();
  const previous = process.env.LUMO_BRAIN_SDK_ENABLED;
  process.env.LUMO_BRAIN_SDK_ENABLED = "false";
  const legacy = async () => Response.json({ legacy: true });
  try {
    const sdkFetch = createBrainSdkFetch({ fetchImpl: legacy });
    assert.equal(sdkFetch, legacy);
  } finally {
    if (previous === undefined) delete process.env.LUMO_BRAIN_SDK_ENABLED;
    else process.env.LUMO_BRAIN_SDK_ENABLED = previous;
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
