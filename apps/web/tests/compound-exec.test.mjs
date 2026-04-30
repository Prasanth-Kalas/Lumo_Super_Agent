/**
 * COMPOUND-EXEC-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/compound-exec.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  replayCompoundTransaction,
} from "../lib/saga.ts";
import {
  runCompoundGraph,
} from "../lib/compound/graph-runner.ts";
import {
  legStatusFrameFromRow,
  serializeLegStatusSse,
} from "../lib/sse/leg-status.ts";
import { validateMerchantManifest } from "../../../packages/lumo-agent-sdk/src/manifest.ts";
import { validateSampleManifestFile } from "../../../samples/_shared/validation.ts";

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

console.log("\ncompound-exec-1");

const migration046 = readFileSync("../../db/migrations/046_compound_exec_1.sql", "utf8");
const stubTripManifest = JSON.parse(
  readFileSync("../../samples/stub-3-leg-trip/lumo-agent.json", "utf8"),
);

await t("migration 046 declares compound graph substrate and occurred_at replay", () => {
  for (const table of [
    "compound_transactions",
    "compound_transaction_dependencies",
    "leg_status_events",
  ]) {
    assert.match(migration046, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(migration046, /alter table public\.transactions\s+add column if not exists compound_transaction_id uuid/);
  assert.match(migration046, /Cycle prevention doctrine/);
  assert.match(migration046, /occurred_at\s+timestamptz not null default now\(\)/);
  assert.doesNotMatch(migration046, /"timestamp"/);
  assert.match(migration046, /compound_transaction_dependencies_validate_legs/);
  assert.match(migration046, /leg_status_events_validate_leg/);
  assert.match(migration046, /leg_status_events_append_only/);
});

await t("replayCompoundTransaction is deterministic over repeated snapshots", () => {
  const snapshot = makeSnapshot({
    status: "rolling_back",
    legs: [
      leg("leg_1", 1, "committed", []),
      leg("leg_2", 2, "committed", ["leg_1"]),
      leg("leg_3", 3, "failed", ["leg_2"]),
    ],
  });

  const plans = Array.from({ length: 10 }, () => replayCompoundTransaction(snapshot));
  assert.equal(new Set(plans.map((plan) => plan.replay_hash)).size, 1);
  assert.deepEqual(
    plans[0].next_actions.map((action) => [action.kind, action.leg_id]),
    [["dispatch_compensation", "leg_2"]],
  );
});

await t("replay rejects cyclic graphs before dependency INSERT", () => {
  const plan = replayCompoundTransaction(makeSnapshot({
    legs: [
      leg("leg_1", 1, "pending", ["leg_2"]),
      leg("leg_2", 2, "pending", ["leg_1"]),
    ],
  }));
  assert.equal(plan.graph_valid, false);
  assert.equal(plan.graph_error, "cyclic_dependency_graph");
  assert.equal(plan.next_actions[0].kind, "mark_manual_review");
});

await t("failure modes map to rollback, wait, manual, and failed compensation", async () => {
  const wait = replayCompoundTransaction(makeSnapshot({
    legs: [leg("leg_1", 1, "in_flight", [])],
  }));
  assert.equal(wait.next_actions[0].kind, "wait_for_in_flight");

  const manual = replayCompoundTransaction(makeSnapshot({
    status: "rolling_back",
    legs: [
      {
        ...leg("leg_1", 1, "committed", []),
        compensation_kind: "manual",
      },
      leg("leg_2", 2, "failed", ["leg_1"]),
    ],
  }));
  assert.equal(manual.next_actions[0].kind, "mark_manual_review");
  assert.equal(manual.next_actions[0].reason, "manual_compensation_required");

  const failedCompensation = await runCompoundGraph({
    snapshot: makeSnapshot({
      status: "rolling_back",
      legs: [
        leg("leg_1", 1, "committed", []),
        leg("leg_2", 2, "failed", ["leg_1"]),
      ],
    }),
    executeLeg: async () => ({ ok: true }),
    compensateLeg: async () => ({ ok: false, error_code: "refund_window_expired" }),
  });
  assert.equal(failedCompensation.snapshot.status, "manual_review");
  assert.equal(failedCompensation.snapshot.legs[0].status, "rollback_failed");
});

await t("SSE v2 helper emits timestamp payload from occurred_at rows", () => {
  const frame = legStatusFrameFromRow({
    leg_id: "leg_1",
    transaction_id: "txn_1",
    agent_id: "stub-3-leg-trip",
    capability_id: "book_flight_stub",
    status: "committed",
    provider_reference: "stub_flight_001",
    evidence: { source: "test" },
    occurred_at: "2026-04-30T00:00:00.123Z",
  });
  assert.equal(frame.timestamp, "2026-04-30T00:00:00.123Z");
  assert.equal("occurred_at" in frame, false);
  assert.match(serializeLegStatusSse(frame), /event: leg_status/);
});

await t("merchant manifest validation requires compensationAction", () => {
  assert.deepEqual(validateMerchantManifest(stubTripManifest), { ok: true, errors: [] });
  const invalid = {
    ...stubTripManifest,
    transaction_capabilities: [
      {
        ...stubTripManifest.transaction_capabilities[0],
        compensationAction: undefined,
      },
    ],
  };
  const result = validateMerchantManifest(invalid);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /compensationAction/);
});

await t("stub 3-leg trip commits two legs, fails third, and rolls back both committed legs", async () => {
  const validation = validateSampleManifestFile(
    "../../samples/stub-3-leg-trip/lumo-agent.json",
  );
  assert.deepEqual(validation.errors, []);

  const snapshot = makeSnapshot({
    legs: [
      leg("flight", 1, "pending", []),
      leg("hotel", 2, "pending", ["flight"]),
      leg("ground", 3, "pending", ["hotel"]),
    ],
  });
  const result = await runCompoundGraph({
    snapshot,
    executeLeg: async (row) =>
      row.leg_id === "ground"
        ? { ok: false, error_code: "provider_timeout" }
        : { ok: true, provider_reference: `ref_${row.leg_id}` },
    compensateLeg: async (row) => ({ ok: true, provider_reference: `cancel_${row.leg_id}` }),
  });

  assert.equal(result.snapshot.status, "rolled_back");
  assert.deepEqual(
    result.snapshot.legs.map((row) => [row.leg_id, row.status]),
    [
      ["flight", "rolled_back"],
      ["hotel", "rolled_back"],
      ["ground", "failed"],
    ],
  );
  assert.deepEqual(
    result.emitted.map((frame) => [frame.leg_id, frame.status]),
    [
      ["flight", "in_flight"],
      ["flight", "committed"],
      ["hotel", "in_flight"],
      ["hotel", "committed"],
      ["ground", "in_flight"],
      ["ground", "failed"],
      ["hotel", "rollback_pending"],
      ["hotel", "rolled_back"],
      ["flight", "rollback_pending"],
      ["flight", "rolled_back"],
    ],
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

function makeSnapshot(overrides = {}) {
  return {
    compound_transaction_id: "compound_00000000-0000-0000-0000-000000000001",
    status: "executing",
    failure_policy: "rollback",
    legs: [leg("leg_1", 1, "pending", [])],
    ...overrides,
  };
}

function leg(id, order, status, depends_on) {
  return {
    leg_id: id,
    transaction_id: `txn_${id}`,
    order,
    agent_id: "stub-3-leg-trip",
    capability_id: `book_${id}`,
    compensation_capability_id: `cancel_${id}`,
    depends_on,
    status,
    compensation_kind: "perfect",
  };
}
