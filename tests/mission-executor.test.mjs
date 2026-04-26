/**
 * Mission step executor tests.
 *
 * Run: node --experimental-strip-types tests/mission-executor.test.mjs
 */

import assert from "node:assert/strict";
import {
  backoffSecondsForAttempt,
  decodeRetryPolicy,
  isStuckRunningStep,
  missionCompletionFromStatuses,
} from "../lib/mission-executor-core.ts";
import { runMissionExecutorTick } from "../lib/mission-executor.ts";

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

async function main() {
  console.log("\nmission executor");

  await t("retry policy decodes bounded attempts and backoff", () => {
    const policy = decodeRetryPolicy({
      max_attempts: 4,
      backoff_seconds: [2, 8, 30, 90, 999],
    });
    assert.deepEqual(policy, {
      max_attempts: 4,
      backoff_seconds: [2, 8, 30, 90],
    });
    assert.equal(backoffSecondsForAttempt(1, policy), 2);
    assert.equal(backoffSecondsForAttempt(3, policy), 30);
    assert.equal(backoffSecondsForAttempt(9, policy), 90);
  });

  await t("stuck running predicate flags only old running rows", () => {
    const now = new Date("2026-04-27T00:10:00Z");
    assert.equal(
      isStuckRunningStep(
        { status: "running", updated_at: "2026-04-27T00:03:30Z" },
        now,
      ),
      true,
    );
    assert.equal(
      isStuckRunningStep(
        { status: "running", updated_at: "2026-04-27T00:06:30Z" },
        now,
      ),
      false,
    );
    assert.equal(
      isStuckRunningStep(
        { status: "ready", updated_at: "2026-04-27T00:00:00Z" },
        now,
      ),
      false,
    );
  });

  await t("mission completion rollup distinguishes complete and failed missions", () => {
    assert.deepEqual(
      missionCompletionFromStatuses(["succeeded", "skipped"], true),
      {
        step_status: "succeeded",
        mission_state: "completed",
        terminal_event: "mission_completed",
      },
    );
    assert.deepEqual(
      missionCompletionFromStatuses(["succeeded", "failed"], false),
      {
        step_status: "failed",
        mission_state: "failed",
        terminal_event: "mission_failed",
      },
    );
  });

  await t("worker executes three ready steps and completes the mission", async () => {
    const db = mockMissionDb({
      missions: [{ id: "mission_1", user_id: userId(), state: "ready" }],
      steps: [
        step("step_1", "mission_1", 0, "ready"),
        step("step_2", "mission_1", 1, "ready"),
        step("step_3", "mission_1", 2, "ready"),
      ],
    });
    const result = await runMissionExecutorTick({
      db,
      dispatchStep: async (claimed) => ({
        ok: true,
        result: { committed: true, step_id: claimed.id },
        latency_ms: 12,
      }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, {
      disabled: 0,
      claimed: 3,
      succeeded: 3,
      failed: 0,
      mission_completed: 1,
      mission_failed: 0,
    });
    assert.deepEqual(db.tables.steps.map((row) => row.status), [
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    assert.equal(db.tables.missions[0].state, "completed");
    assert.deepEqual(db.tables.events.map((row) => row.event_type), [
      "step_started",
      "step_succeeded",
      "step_started",
      "step_succeeded",
      "step_started",
      "step_succeeded",
      "mission_completed",
    ]);
  });

  await t("worker falls back to direct ready-step claim when rpc returns no rows", async () => {
    const db = mockMissionDb(
      {
        missions: [{ id: "mission_fallback", user_id: userId(), state: "ready" }],
        steps: [
          step("fallback_1", "mission_fallback", 0, "ready"),
          step("fallback_2", "mission_fallback", 1, "ready"),
        ],
      },
      { rpcReturnsEmpty: true },
    );
    const result = await runMissionExecutorTick({
      db,
      dispatchStep: async (claimed) => ({
        ok: true,
        result: { committed: true, step_id: claimed.id },
        latency_ms: 4,
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.counts.claimed, 2);
    assert.equal(result.counts.succeeded, 2);
    assert.equal(result.counts.mission_completed, 1);
    assert.deepEqual(db.tables.steps.map((row) => row.status), ["succeeded", "succeeded"]);
    assert.equal(db.tables.missions[0].state, "completed");
  });

  await t("worker fails the mission on a non-retryable step failure", async () => {
    const db = mockMissionDb({
      missions: [{ id: "mission_2", user_id: userId(), state: "ready" }],
      steps: [
        step("step_a", "mission_2", 0, "ready"),
        step("step_b", "mission_2", 1, "ready"),
        step("step_c", "mission_2", 2, "ready"),
      ],
    });
    const result = await runMissionExecutorTick({
      db,
      dispatchStep: async (claimed) =>
        claimed.id === "step_b"
          ? {
              ok: false,
              error: { code: "connection_required", message: "Connect the app first." },
              latency_ms: 3,
            }
          : {
              ok: true,
              result: { committed: true, step_id: claimed.id },
              latency_ms: 5,
            },
    });

    assert.equal(result.ok, false);
    assert.equal(db.tables.steps[0].status, "succeeded");
    assert.equal(db.tables.steps[1].status, "failed");
    assert.equal(db.tables.steps[2].status, "ready");
    assert.equal(db.tables.missions[0].state, "failed");
    assert.ok(db.tables.events.some((row) => row.event_type === "mission_failed"));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

function step(id, mission_id, step_order, status) {
  return {
    id,
    mission_id,
    user_id: userId(),
    step_order,
    agent_id: `agent_${step_order}`,
    tool_name: `agent_${step_order}_tool`,
    reversibility: "reversible",
    status,
    inputs: { step_order },
    outputs: {},
    confirmation_card_id: null,
    updated_at: "2026-04-27T00:00:00Z",
  };
}

function mockMissionDb(seed, options = {}) {
  const tables = {
    missions: seed.missions.map((row) => ({ ...row })),
    steps: seed.steps.map((row) => ({ ...row })),
    events: [],
  };
  return {
    tables,
    async rpc(fn, args) {
      if (fn !== "next_mission_step_for_execution") {
        return { data: null, error: { message: `unknown rpc ${fn}` } };
      }
      if (options.rpcReturnsEmpty) return { data: [], error: null };
      const limit = Number(args?.requested_limit ?? 10);
      const claimable = tables.steps
        .filter((row) => row.status === "ready" && priorStepsDone(tables.steps, row))
        .sort((a, b) => a.step_order - b.step_order)
        .slice(0, limit);
      for (const row of claimable) {
        row.status = "running";
        row.started_at = row.started_at ?? new Date().toISOString();
      }
      for (const mission of tables.missions) {
        if (claimable.some((row) => row.mission_id === mission.id) && mission.state === "ready") {
          mission.state = "executing";
        }
      }
      return {
        data: claimable.map((row) => ({ ...row })),
        error: null,
      };
    },
    from(table) {
      return new MockQuery(tables, table);
    },
  };
}

function priorStepsDone(steps, row) {
  return steps
    .filter((candidate) => candidate.mission_id === row.mission_id)
    .filter((candidate) => candidate.step_order < row.step_order)
    .every((candidate) => ["succeeded", "skipped"].includes(candidate.status));
}

class MockQuery {
  constructor(tables, table) {
    this.tables = tables;
    this.table = table;
    this.filters = [];
    this.operation = "select";
    this.updatePayload = null;
    this.returnSelection = false;
  }

  select() {
    if (this.operation === "update") {
      this.returnSelection = true;
    } else {
      this.operation = "select";
    }
    return this;
  }

  update(payload) {
    this.operation = "update";
    this.updatePayload = payload;
    return this;
  }

  insert(values) {
    if (this.table === "mission_execution_events") {
      this.tables.events.push({ ...values, created_at: new Date().toISOString() });
    }
    return Promise.resolve({ error: null });
  }

  eq(column, value) {
    this.filters.push([column, value]);
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    const rows = this.rowsForTable();
    const matches = rows.filter((row) => this.matches(row));
    if (this.operation === "update") {
      for (const row of matches) Object.assign(row, this.updatePayload);
      return {
        data: this.returnSelection ? matches.map((row) => ({ ...row })) : null,
        error: null,
      };
    }
    let data = matches.map((row) => ({ ...row }));
    if (typeof this.limitCount === "number") data = data.slice(0, this.limitCount);
    return { data, error: null };
  }

  rowsForTable() {
    if (this.table === "missions") return this.tables.missions;
    if (this.table === "mission_steps") return this.tables.steps;
    if (this.table === "mission_execution_events") return this.tables.events;
    return [];
  }

  matches(row) {
    for (const [column, value] of this.filters) {
      if (row[column] !== value) return false;
    }
    return true;
  }
}

function userId() {
  return "00000000-0000-0000-0000-000000000001";
}

await main();
