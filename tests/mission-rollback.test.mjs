/**
 * Durable mission rollback tests.
 *
 * Run: node --experimental-strip-types tests/mission-rollback.test.mjs
 */

import assert from "node:assert/strict";
import {
  renderCompensatingInputs,
  rollbackActionForStep,
  rollbackStepAlreadyStarted,
  rollbackStepAlreadyTerminal,
  rollbackTransition,
} from "../lib/mission-rollback-core.ts";
import {
  initiateMissionRollback,
  runMissionRollbackTick,
} from "../lib/mission-rollback.ts";

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
  console.log("\nmission rollback");

  await t("rollback transitions active missions into rolling_back", () => {
    assert.deepEqual(rollbackTransition("executing", { trigger: "user" }), {
      ok: true,
      target: "rolling_back",
    });
    assert.deepEqual(rollbackTransition("awaiting_permissions", { trigger: "user" }), {
      ok: true,
      target: "rolled_back",
    });
    assert.deepEqual(rollbackTransition("completed", { trigger: "admin", force: true }), {
      ok: true,
      target: "rolling_back",
    });
    assert.equal(rollbackTransition("rolled_back", { trigger: "user" }).ok, false);
  });

  await t("template renderer substitutes outputs paths", () => {
    assert.deepEqual(
      renderCompensatingInputs(
        {
          booking_id: "{{outputs.booking_id}}",
          nested: { amount: "{{outputs.payment.amount_cents}}" },
          literal: "cancel {{outputs.kind}} now",
        },
        {
          booking_id: "book_123",
          kind: "hotel",
          payment: { amount_cents: 29900 },
        },
      ),
      {
        booking_id: "book_123",
        nested: { amount: "29900" },
        literal: "cancel hotel now",
      },
    );
  });

  await t("idempotency helpers detect started and terminal rollback events", () => {
    const events = [
      { step_id: "step_1", event_type: "rollback_step_started" },
      { step_id: "step_2", event_type: "rollback_step_skipped" },
    ];
    assert.equal(rollbackStepAlreadyStarted("step_1", events), true);
    assert.equal(rollbackStepAlreadyTerminal("step_1", events), false);
    assert.equal(rollbackStepAlreadyTerminal("step_2", events), true);
  });

  await t("rollbackActionForStep chooses compensate or skip by reversibility", () => {
    assert.deepEqual(
      rollbackActionForStep(step("step_a", "mission_1", 0, "reversible")),
      { kind: "skip", reason: "reversible_noop" },
    );
    assert.deepEqual(
      rollbackActionForStep(step("step_b", "mission_1", 1, "irreversible")),
      { kind: "skip", reason: "irreversible" },
    );
    const action = rollbackActionForStep(
      step("step_c", "mission_1", 2, "compensating", {
        outputs: { booking_id: "book_456" },
        inputs: {
          rollback: {
            compensating_tool: "hotel_cancel_booking",
            compensating_inputs_template: { booking_id: "{{outputs.booking_id}}" },
          },
        },
      }),
    );
    assert.deepEqual(action, {
      kind: "compensate",
      tool_name: "hotel_cancel_booking",
      inputs: { booking_id: "book_456" },
    });
  });

  await t("worker rolls back three succeeded steps in reverse order", async () => {
    const db = mockRollbackDb({
      missions: [{ id: "mission_1", user_id: userId(), state: "executing" }],
      steps: [
        step("step_0", "mission_1", 0, "reversible"),
        step("step_1", "mission_1", 1, "compensating", {
          outputs: { booking_id: "hotel_123" },
          inputs: {
            rollback: {
              compensating_tool: "hotel_cancel_booking",
              compensating_inputs_template: { booking_id: "{{outputs.booking_id}}" },
            },
          },
        }),
        step("step_2", "mission_1", 2, "irreversible"),
      ],
    });

    const initiated = await initiateMissionRollback({
      mission_id: "mission_1",
      trigger: "user",
      reason: "user_cancel",
      actor_user_id: userId(),
      user_id: userId(),
      db,
    });
    assert.equal(initiated.ok, true);
    assert.equal(db.tables.missions[0].state, "rolling_back");

    const result = await runMissionRollbackTick({
      db,
      dispatchTool: async (toolName, args) => ({
        ok: true,
        result: { toolName, args, cancelled: true },
        latency_ms: 7,
      }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, {
      disabled: 0,
      claimed: 3,
      compensated: 1,
      skipped: 2,
      failed: 0,
      rollback_completed: 1,
    });
    assert.equal(db.tables.missions[0].state, "rolled_back");
    assert.deepEqual(db.tables.steps.map((row) => row.status), [
      "rolled_back",
      "rolled_back",
      "succeeded",
    ]);
    assert.deepEqual(db.tables.events.map((row) => row.event_type), [
      "rollback_initiated",
      "rollback_step_skipped",
      "rollback_step_started",
      "rollback_step_succeeded",
      "rollback_step_skipped",
      "rollback_completed",
    ]);
    assert.deepEqual(
      db.tables.attempts.map((row) => row.compensating_tool).filter(Boolean),
      ["hotel_cancel_booking"],
    );
  });

  await t("initiating rollback completes missions with no executed steps", async () => {
    const db = mockRollbackDb({
      missions: [{ id: "mission_pending", user_id: userId(), state: "ready" }],
      steps: [
        step("step_pending", "mission_pending", 0, "reversible", {
          status: "pending",
          finished_at: null,
        }),
      ],
    });

    const result = await initiateMissionRollback({
      mission_id: "mission_pending",
      trigger: "user",
      reason: "workspace_cancel",
      actor_user_id: userId(),
      user_id: userId(),
      db,
    });

    assert.equal(result.ok, true);
    assert.equal(result.state, "rolled_back");
    assert.equal(db.tables.missions[0].state, "rolled_back");
    assert.deepEqual(db.tables.events.map((row) => row.event_type), [
      "rollback_initiated",
      "rollback_completed",
    ]);
    assert.deepEqual(db.tables.events.at(-1).payload, {
      forward_steps: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    });
  });

  await t("rollback tick finishes already-initiated missions with no claimable steps", async () => {
    const db = mockRollbackDb({
      missions: [{ id: "mission_stuck", user_id: userId(), state: "rolling_back" }],
      steps: [
        step("step_stuck", "mission_stuck", 0, "reversible", {
          status: "pending",
          finished_at: null,
        }),
      ],
      events: [
        {
          mission_id: "mission_stuck",
          step_id: null,
          event_type: "rollback_initiated",
          payload: { reason: "workspace_cancel" },
        },
      ],
    });

    const result = await runMissionRollbackTick({ db });

    assert.equal(result.ok, true);
    assert.equal(result.counts.claimed, 0);
    assert.equal(result.counts.rollback_completed, 1);
    assert.equal(db.tables.missions[0].state, "rolled_back");
    assert.deepEqual(db.tables.events.map((row) => row.event_type), [
      "rollback_initiated",
      "rollback_completed",
    ]);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

function step(id, mission_id, step_order, reversibility, overrides = {}) {
  return {
    id,
    mission_id,
    user_id: userId(),
    step_order,
    agent_id: `agent_${step_order}`,
    tool_name: `agent_${step_order}_tool`,
    reversibility,
    status: overrides.status ?? "succeeded",
    inputs: overrides.inputs ?? {},
    outputs: overrides.outputs ?? {},
    finished_at: overrides.finished_at ?? "2026-04-27T00:00:00Z",
    confirmation_card_id: null,
  };
}

function mockRollbackDb(seed) {
  const tables = {
    missions: seed.missions.map((row) => ({ ...row })),
    steps: seed.steps.map((row) => ({ ...row })),
    events: (seed.events ?? []).map((row) => ({ ...row })),
    attempts: [],
  };
  return {
    tables,
    async rpc(fn, args) {
      if (fn !== "next_rollback_step_for_execution") {
        return { data: null, error: { message: `unknown rpc ${fn}` } };
      }
      const limit = Number(args?.requested_limit ?? 10);
      const claimable = tables.steps
        .filter((row) => row.status === "succeeded")
        .filter((row) => missionFor(tables, row.mission_id)?.state === "rolling_back")
        .filter((row) => !hasTerminalRollbackEvent(tables.events, row.id))
        .filter((row) => laterStepsTerminal(tables, row))
        .sort((a, b) => b.step_order - a.step_order)
        .slice(0, limit);
      for (const row of claimable) {
        if (!tables.attempts.some((attempt) => attempt.step_id === row.id && attempt.attempt === 1)) {
          tables.attempts.push({
            mission_id: row.mission_id,
            step_id: row.id,
            attempt: 1,
            compensating_tool: null,
            rendered_inputs: {},
            status: "running",
          });
        }
      }
      return {
        data: claimable.map((row) => ({
          ...row,
          user_id: missionFor(tables, row.mission_id)?.user_id,
        })),
        error: null,
      };
    },
    from(table) {
      return new MockQuery(tables, table);
    },
  };
}

function laterStepsTerminal(tables, row) {
  return tables.steps
    .filter((candidate) => candidate.mission_id === row.mission_id)
    .filter((candidate) => candidate.step_order > row.step_order)
    .filter((candidate) => candidate.status === "succeeded")
    .every((candidate) => hasTerminalRollbackEvent(tables.events, candidate.id));
}

function hasTerminalRollbackEvent(events, stepId) {
  return events.some(
    (event) =>
      event.step_id === stepId &&
      [
        "rollback_step_succeeded",
        "rollback_step_failed",
        "rollback_step_skipped",
      ].includes(event.event_type),
  );
}

function missionFor(tables, missionId) {
  return tables.missions.find((row) => row.id === missionId) ?? null;
}

class MockQuery {
  constructor(tables, table) {
    this.tables = tables;
    this.table = table;
    this.filters = [];
    this.operation = "select";
    this.updatePayload = null;
    this.insertPayload = null;
  }

  select() {
    this.operation = "select";
    return this;
  }

  update(payload) {
    this.operation = "update";
    this.updatePayload = payload;
    return this;
  }

  insert(payload) {
    this.operation = "insert";
    this.insertPayload = payload;
    return this.execute();
  }

  upsert(payload) {
    const rows = this.rowsForTable();
    const existing = rows.find(
      (row) => row.step_id === payload.step_id && row.attempt === payload.attempt,
    );
    if (existing) Object.assign(existing, payload);
    else rows.push({ ...payload, created_at: new Date().toISOString() });
    return Promise.resolve({ data: null, error: null });
  }

  eq(column, value) {
    this.filters.push([column, value]);
    return this;
  }

  order() {
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
    if (this.operation === "insert") {
      this.rowsForTable().push({
        ...this.insertPayload,
        created_at: new Date().toISOString(),
      });
      return { data: null, error: null };
    }
    const rows = this.rowsForTable();
    const matches = rows.filter((row) => this.matches(row));
    if (this.operation === "update") {
      for (const row of matches) Object.assign(row, this.updatePayload);
      return { data: null, error: null };
    }
    let data = matches.map((row) => ({ ...row }));
    if (typeof this.limitCount === "number") data = data.slice(0, this.limitCount);
    return { data, error: null };
  }

  rowsForTable() {
    if (this.table === "missions") return this.tables.missions;
    if (this.table === "mission_steps") return this.tables.steps;
    if (this.table === "mission_execution_events") return this.tables.events;
    if (this.table === "mission_step_rollback_attempts") return this.tables.attempts;
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
