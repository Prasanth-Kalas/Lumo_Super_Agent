import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateSigningMaterial, signBundle } from "../../../packages/lumo-agent-sdk/src/cli/submit.ts";
import { runChecks } from "../lib/trust/check-pipeline.ts";
import { verifyBundleSignature } from "../lib/trust/keys.ts";
import {
  declaredScopes,
  manifestDependencies,
} from "../lib/trust/checks/types.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.stack ?? e.message}`);
  }
};

function fakeDb(keyRow) {
  return {
    from(table) {
      return new FakeQuery(table, keyRow);
    },
  };
}

class FakeQuery {
  constructor(table, keyRow) {
    this.table = table;
    this.keyRow = keyRow;
    this.op = "select";
  }
  select() { this.op = "select"; return this; }
  update() { this.op = "update"; return this; }
  eq() { return this; }
  limit() { return this; }
  then(resolve) {
    if (this.op === "select" && this.table === "developer_keys") {
      resolve({ data: [this.keyRow], error: null });
      return;
    }
    resolve({ data: null, error: null });
  }
}

console.log("\ntrust review pipeline");

const baseManifest = {
  agent_id: "trust-sample",
  version: "1.0.0",
  domain: "trust",
  display_name: "Trust Sample",
  one_liner: "A sample agent used for trust pipeline tests.",
  intents: ["trust.sample"],
  example_utterances: ["Run the trust sample"],
  openapi_url: "https://example.com/openapi.json",
  ui: { components: [] },
  health_url: "https://example.com/health",
  sla: { p50_latency_ms: 200, p95_latency_ms: 1000, availability_target: 0.99 },
  pii_scope: [],
  requires_payment: false,
  supported_regions: ["US"],
  capabilities: {
    sdk_version: "0.4.1",
    supports_compound_bookings: false,
    implements_cancellation: false,
  },
  connect: { model: "none" },
  x_lumo_sample: {
    requires: { scopes: ["read.profile"] },
    cost_model: { max_cost_usd_per_invocation: 0.01 },
  },
};

await t("manifest helper extracts declared scopes and dependencies", () => {
  const manifest = {
    ...baseManifest,
    dependencies: { lodash: "4.17.21" },
  };
  assert.deepEqual(declaredScopes(manifest), ["read.profile"]);
  assert.deepEqual(manifestDependencies(manifest), [
    { name: "lodash", version: "4.17.21", ecosystem: "npm" },
  ]);
});

await t("five-check pipeline passes a clean bundle", async () => {
  const report = await runChecks({
    agentId: "trust-sample",
    agentVersion: "1.0.0",
    manifest: baseManifest,
    bundleBytes: new TextEncoder().encode("export default function agent() { return true }"),
  });
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 5);
  assert.equal(report.summary.fail, 0);
});

await t("static analysis fails blocked bundle code before sandbox", async () => {
  const report = await runChecks({
    agentId: "trust-sample",
    agentVersion: "1.0.0",
    manifest: baseManifest,
    bundleBytes: new TextEncoder().encode("eval('bad')"),
  });
  assert.equal(report.passed, false);
  assert.equal(report.failed_check, "static");
  assert(report.checks.some((check) => check.reason_codes.includes("eval_usage")));
});

await t("behavioral fingerprint rejects undeclared scopes", async () => {
  const report = await runChecks({
    agentId: "trust-sample",
    agentVersion: "1.0.0",
    manifest: {
      ...baseManifest,
      x_trust: { touched_scopes: ["write.payment.transfer"] },
    },
    bundleBytes: new TextEncoder().encode("safe"),
  });
  assert.equal(report.passed, false);
  assert.equal(report.failed_check, "fingerprint");
});

await t("author key signs and server verification accepts the bundle", async () => {
  const material = generateSigningMaterial();
  const signed = signBundle({
    agentId: "trust-sample",
    version: "1.0.0",
    bundleBytes: new TextEncoder().encode("bundle"),
    material,
  });
  const db = fakeDb({
    user_id: "user-1",
    key_id: signed.key_id,
    public_key_pem: material.publicKeyPem,
    public_key_jwk: null,
    algorithm: "ecdsa-p256",
    fingerprint_sha256: signed.fingerprint_sha256,
    label: null,
    state: "active",
    registered_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
  });
  const result = await verifyBundleSignature({
    db,
    agentId: "trust-sample",
    version: "1.0.0",
    bundleSha256: signed.bundle_sha256,
    signature: signed.signature,
    keyId: signed.key_id,
    signerUserId: "user-1",
  });
  assert.equal(result.ok, true);
});

await t("migration 041 encodes queue, key, and health-signal invariants", () => {
  const sql = readFileSync("../../db/migrations/041_trust_1_review_pipeline.sql", "utf8");
  assert(sql.includes("create table if not exists public.agent_review_queue"));
  assert(sql.includes("create unique index if not exists agent_review_queue_by_source_submission"));
  assert(sql.includes("create unique index if not exists agent_review_queue_by_promotion_request"));
  assert(sql.includes("create unique index if not exists agent_review_queue_by_identity_user"));
  assert(sql.includes("create table if not exists public.agent_health_signals"));
  assert(sql.includes("create table if not exists public.developer_keys"));
  assert(sql.includes("create or replace function public.developer_keys_guard()"));
  assert(sql.includes("developer_keys_fingerprint_unique"));
});

await t("health monitor cron is registered with demotion and auto-kill thresholds", () => {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert(
    vercel.crons.some(
      (cron) => cron.path === "/api/cron/agent-health-monitor" && cron.schedule === "0 */6 * * *",
    ),
  );
  assert.equal(vercel.functions["app/api/cron/agent-health-monitor/route.ts"].maxDuration, 60);
  const monitor = readFileSync("lib/trust/health-monitor.ts", "utf8");
  assert(monitor.includes("setAgentKillSwitch"));
  assert(monitor.includes("enqueueDemotionReview"));
  assert(monitor.includes("> 0.25"));
  assert(monitor.includes("> 0.05"));
  assert(monitor.includes(">= 3"));
});

await t("promotion and identity submissions enqueue reviewer work", () => {
  const dashboard = readFileSync("lib/developer-dashboard.ts", "utf8");
  const queue = readFileSync("lib/trust/queue.ts", "utf8");
  assert(dashboard.includes("enqueuePromotionReview"));
  assert(dashboard.includes("enqueueIdentityVerificationReview"));
  assert(queue.includes('request_type: "promotion"'));
  assert(queue.includes('request_type: "identity_verification"'));
  assert(queue.includes(".from(\"developer_promotion_requests\")"));
  assert(queue.includes(".from(\"developer_identity_verifications\")"));
});

if (fail > 0) {
  console.error(`\n${fail} trust review pipeline test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} trust review pipeline test(s) passed`);
