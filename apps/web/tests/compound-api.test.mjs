/**
 * COMPOUND-EXEC-2 regression suite.
 *
 * Run: node --experimental-strip-types tests/compound-api.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CompoundPersistenceError,
  createCompoundTransaction,
  legStatusFramesFromEvents,
  normalizeCompoundCreatePayload,
  stableStringify,
} from "../lib/compound/persistence.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.log(`  ✗ ${name}\n    ${error.stack ?? error.message}`);
  }
};

console.log("\ncompound-exec-2 api");

const migration046 = readFileSync("../../db/migrations/046_compound_exec_1.sql", "utf8");
const migration047 = readFileSync("../../db/migrations/047_compound_exec_2_persistence_rpc.sql", "utf8");
const migration048 = readFileSync("../../db/migrations/048_compound_idempotency_conflict.sql", "utf8");
const postRoute = readFileSync("app/api/compound/transactions/route.ts", "utf8");
const streamRoute = readFileSync("app/api/compound/transactions/[id]/stream/route.ts", "utf8");
const persistence = readFileSync("lib/compound/persistence.ts", "utf8");
const sampleMain = readFileSync("../../samples/stub-3-leg-trip/src/main.ts", "utf8");
const rootPackage = JSON.parse(readFileSync("../../package.json", "utf8"));

await t("POST payload happy path normalizes and validates before persistence", () => {
  const normalized = normalizeCompoundCreatePayload(makeVegasGraph("compound-api-happy"));
  assert.match(normalized.graph_hash, /^[a-f0-9]{64}$/);
  assert.equal(normalized.replay_plan.graph_valid, true);
  assert.equal(normalized.authorized_amount_cents, 300);
  assert.deepEqual(
    normalized.legs.map((leg) => [leg.client_leg_id, leg.depends_on]),
    [
      ["flight", []],
      ["hotel", ["flight"]],
      ["ground", ["hotel"]],
    ],
  );
});

await t("idempotency path is enforced by unique key and RPC existing-return branch", () => {
  assert.match(migration047, /where user_id = v_user_id\s+and idempotency_key = v_idempotency_key/);
  assert.match(migration047, /'existing', true/);
  assert.match(migration046, /unique \(user_id, idempotency_key\)/);
  assert.match(postRoute, /result\.existing \? 200 : 201/);
});

await t("same graph idempotency returns the prior compound id", async () => {
  const existingId = "11111111-1111-4111-8111-111111111111";
  const result = await createCompoundTransaction({
    userId: "22222222-2222-4222-8222-222222222222",
    payload: makeVegasGraph("compound-api-same-key"),
    db: {
      rpc: async () => ({
        error: null,
        data: {
          compound_transaction_id: existingId,
          status: "authorized",
          graph_hash: normalizeCompoundCreatePayload(makeVegasGraph("compound-api-same-key")).graph_hash,
          existing: true,
        },
      }),
    },
  });
  assert.equal(result.compound_transaction_id, existingId);
  assert.equal(result.existing, true);
});

await t("divergent graph idempotency returns 409 with existing compound id", async () => {
  const existingId = "33333333-3333-4333-8333-333333333333";
  await assert.rejects(
    () =>
      createCompoundTransaction({
        userId: "22222222-2222-4222-8222-222222222222",
        payload: makeVegasGraph("compound-api-conflict"),
        db: {
          rpc: async () => ({
            data: null,
            error: {
              message: "INVALID_COMPOUND_GRAPH_HASH_CONFLICT",
              hint: `existing_compound_id=${existingId}`,
            },
          }),
        },
      }),
    (error) =>
      error instanceof CompoundPersistenceError &&
      error.code === "idempotency_key_conflict" &&
      error.status === 409 &&
      error.details?.existing_compound_id === existingId,
  );
  assert.match(migration048, /INVALID_COMPOUND_GRAPH_HASH_CONFLICT/);
  assert.match(migration048, /v_existing\.graph_hash is distinct from v_graph_hash/);
  assert.match(postRoute, /existing_compound_id/);
});

await t("cycle rejection returns cyclic_dependency_graph before dependency insert", () => {
  assert.throws(
    () => normalizeCompoundCreatePayload({
      ...makeVegasGraph("compound-api-cycle"),
      dependencies: [
        {
          dependency_client_leg_id: "flight",
          dependent_client_leg_id: "hotel",
          edge_type: "requires_destination",
        },
        {
          dependency_client_leg_id: "hotel",
          dependent_client_leg_id: "flight",
          edge_type: "requires_arrival_time",
        },
      ],
    }),
    (error) =>
      error instanceof CompoundPersistenceError &&
      error.code === "cyclic_dependency_graph" &&
      error.status === 400,
  );
  assert.match(persistence, /replayCompoundTransaction/);
  assert.match(persistence, /throw new CompoundPersistenceError\(replayPlan\.graph_error/);
});

await t("unauthorized compound stream access returns 404 to avoid id enumeration", () => {
  assert.match(streamRoute, /readCompoundStatusForUser/);
  assert.match(streamRoute, /compound_transaction_not_found/);
  assert.match(streamRoute, /404/);
  assert.doesNotMatch(streamRoute, /not_found.*403/);
});

await t("SSE replay is deterministic for ordered leg_status_events rows", () => {
  const rows = [
    eventRow(1, "2026-04-30T10:00:00.001Z", "flight", "pending"),
    eventRow(2, "2026-04-30T10:00:00.002Z", "flight", "in_flight"),
    eventRow(3, "2026-04-30T10:00:00.003Z", "flight", "committed"),
  ];
  const first = legStatusFramesFromEvents(rows);
  const second = legStatusFramesFromEvents(rows);
  assert.deepEqual(first, second);
  assert.equal(stableStringify(first), stableStringify(second));
  assert.match(persistence, /order\("occurred_at", \{ ascending: true \}\)\s+\.order\("id", \{ ascending: true \}\)/);
});

await t("snapshot loader closes the ordered SELECT nit", () => {
  assert.match(persistence, /export async function loadCompoundSnapshot/);
  assert.match(persistence, /loadLegStatusEvents\(db, compound\.id\)/);
  assert.match(persistence, /latestEventByLeg/);
});

await t("stub-3-leg-trip has a runnable API demo script", () => {
  assert.match(sampleMain, /POST/);
  assert.match(sampleMain, /\/api\/compound\/transactions/);
  assert.match(sampleMain, /\/stream/);
  assert.equal(rootPackage.scripts["sample:3-leg-trip"], "npm run demo --workspace samples/stub-3-leg-trip");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

function makeVegasGraph(idempotency_key) {
  return {
    idempotency_key,
    currency: "USD",
    confirmation_digest:
      "1111111111111111111111111111111111111111111111111111111111111111",
    line_items: [
      { label: "Synthetic flight", amountCents: 100 },
      { label: "Synthetic hotel", amountCents: 100 },
      { label: "Synthetic ground", amountCents: 100 },
    ],
    legs: [
      leg("flight", "book_flight_stub", "cancel_flight_stub"),
      leg("hotel", "book_hotel_stub", "cancel_hotel_stub"),
      leg("ground", "book_ground_stub", "cancel_ground_stub"),
    ],
    dependencies: [
      {
        dependency_client_leg_id: "flight",
        dependent_client_leg_id: "hotel",
        edge_type: "requires_destination",
      },
      {
        dependency_client_leg_id: "hotel",
        dependent_client_leg_id: "ground",
        edge_type: "requires_arrival_time",
      },
    ],
  };
}

function leg(client_leg_id, capability_id, compensation_capability_id) {
  return {
    client_leg_id,
    agent_id: "stub-3-leg-trip",
    agent_version: "1.0.0",
    provider: "mock_merchant",
    capability_id,
    compensation_capability_id,
    amount_cents: 100,
    currency: "USD",
    compensation_kind: "perfect",
  };
}

function eventRow(id, occurred_at, leg_id, status) {
  return {
    id,
    compound_transaction_id: "compound_001",
    transaction_id: `txn_${leg_id}`,
    leg_id,
    agent_id: "stub-3-leg-trip",
    capability_id: `book_${leg_id}_stub`,
    status,
    provider_reference: null,
    evidence: {},
    occurred_at,
    created_at: occurred_at,
  };
}
