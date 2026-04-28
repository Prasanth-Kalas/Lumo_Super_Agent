/**
 * PERM-1 pure helper tests.
 *
 * Run: node --experimental-strip-types tests/permissions.test.mjs
 */

import assert from "node:assert/strict";
import {
  consentTextForAgent,
  consentTextHash,
  describePermissionScope,
  permissionScopesForManifest,
} from "../lib/permission-manifest.ts";

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

console.log("\npermissions");

await t("oauth required scopes become consent descriptors", () => {
  const scopes = permissionScopesForManifest(manifest({
    connect: {
      model: "oauth2",
      authorize_url: "https://example.com/auth",
      token_url: "https://example.com/token",
      client_id_env: "EXAMPLE_CLIENT_ID",
      scopes: [
        { name: "read.email.headers", description: "Read headers", required: true },
        { name: "write.email.send", description: "Send email", required: false },
      ],
    },
  }));
  assert.deepEqual(scopes.map((scope) => scope.scope), ["read.email.headers"]);
  assert.equal(scopes[0].category, "read");
});

await t("financial scope qualifier defaults are parsed from manifest scope", () => {
  const scope = describePermissionScope(
    "write.financial.transfer.up_to_per_invocation:500_usd.per_day:1500_usd",
  );
  assert.equal(scope.category, "financial");
  assert.equal(scope.requiresConfirmation, true);
  assert.equal(scope.defaultConstraints.up_to_per_invocation_usd, 500);
  assert.equal(scope.defaultConstraints.per_day_usd, 1500);
});

await t("money routing fallback requests financial transfer scope", () => {
  const scopes = permissionScopesForManifest(
    manifest({ connect: { model: "lumo_id", audience: "sample" } }),
    {
      agent_id: "sample",
      operation_id: "book",
      http_method: "POST",
      path: "/book",
      cost_tier: "money",
      requires_confirmation: "structured-booking",
      pii_required: [],
      intent_tags: [],
    },
  );
  assert.deepEqual(scopes.map((scope) => scope.scope), ["write.financial.transfer"]);
});

await t("consent hash is stable and changes when granted scopes change", () => {
  const m = manifest();
  const read = [describePermissionScope("read.calendar.events")];
  const write = [
    describePermissionScope("read.calendar.events"),
    describePermissionScope("write.calendar.events"),
  ];
  const readHash = consentTextHash(consentTextForAgent(m, read));
  assert.equal(readHash, consentTextHash(consentTextForAgent(m, read)));
  assert.notEqual(readHash, consentTextHash(consentTextForAgent(m, write)));
});

await t("provider OAuth scopes keep provider URLs visible to the user", () => {
  const scope = describePermissionScope("https://www.googleapis.com/auth/calendar.events");
  assert.equal(scope.category, "other");
  assert.equal(
    scope.description,
    "Use provider OAuth scope https://www.googleapis.com/auth/calendar.events",
  );
});

if (fail > 0) {
  console.error(`\n${fail} permissions test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} permissions test(s) passed`);

function manifest(overrides = {}) {
  return {
    agent_id: "sample-agent",
    version: "1.0.0",
    domain: "sample",
    display_name: "Sample Agent",
    one_liner: "Sample",
    intents: ["sample.intent"],
    example_utterances: [],
    openapi_url: "https://example.com/openapi.json",
    ui: { components: [] },
    health_url: "https://example.com/health",
    sla: { p50_latency_ms: 100, p95_latency_ms: 500, availability_target: 0.99 },
    pii_scope: [],
    requires_payment: false,
    supported_regions: ["US"],
    capabilities: {
      sdk_version: "0.4.1",
      supports_compound_bookings: false,
      implements_cancellation: false,
    },
    connect: { model: "none" },
    listing: null,
    owner_team: "Tests",
    ...overrides,
  };
}
