/**
 * Mission gate-resolution tests.
 *
 * Run: node --experimental-strip-types tests/mission-gate-resolution.test.mjs
 */

import assert from "node:assert/strict";
import {
  inputAdvancement,
  pendingStepIds,
  stepsToAdvanceOnPermissionGrant,
} from "../lib/mission-gate-resolution-core.ts";
import { resolvePermissionGate } from "../lib/mission-gate-resolution.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

console.log("\nmission gate resolution");

await t("single-agent permission resolves one matching pending step", () => {
  const result = stepsToAdvanceOnPermissionGrant(
    mission("mission_1", "awaiting_permissions"),
    [
      step("step_1", "mission_1", "google", "pending"),
      step("step_2", "mission_1", "flight", "pending"),
    ],
    "google",
  );
  assert.deepEqual(result, {
    step_ids: ["step_1"],
    blocked_agent_ids: ["flight"],
    complete: false,
    next_state: "awaiting_permissions",
    reason: "permission_blocked",
  });
});

await t("permission gate completes when the last pending agent resolves", () => {
  const result = stepsToAdvanceOnPermissionGrant(
    mission("mission_1", "awaiting_permissions"),
    [
      step("step_1", "mission_1", "google", "ready"),
      step("step_2", "mission_1", "flight", "pending"),
    ],
    "flight",
  );
  assert.deepEqual(result, {
    step_ids: ["step_2"],
    blocked_agent_ids: [],
    complete: true,
    next_state: "ready",
    reason: undefined,
  });
});

await t("permission grant does not touch unrelated missions or agents", () => {
  const wrongMission = stepsToAdvanceOnPermissionGrant(
    mission("mission_2", "ready"),
    [step("step_3", "mission_2", "google", "pending")],
    "google",
  );
  assert.equal(wrongMission.step_ids.length, 0);
  assert.equal(wrongMission.reason, "mission_not_awaiting_permissions:ready");

  const wrongAgent = stepsToAdvanceOnPermissionGrant(
    mission("mission_1", "awaiting_permissions"),
    [step("step_1", "mission_1", "flight", "pending")],
    "google",
  );
  assert.deepEqual(wrongAgent.step_ids, []);
  assert.deepEqual(wrongAgent.blocked_agent_ids, ["flight"]);
  assert.equal(wrongAgent.reason, "no_matching_pending_steps");
});

await t("partial permission resolution names remaining blocked agents", () => {
  const result = stepsToAdvanceOnPermissionGrant(
    mission("mission_6", "awaiting_permissions"),
    [
      step("step_1", "mission_6", "google", "pending"),
      step("step_2", "mission_6", "flight", "pending"),
      step("step_3", "mission_6", "hotel", "pending"),
    ],
    "google",
  );
  assert.deepEqual(result.step_ids, ["step_1"]);
  assert.equal(result.complete, false);
  assert.equal(result.next_state, "awaiting_permissions");
  assert.deepEqual(result.blocked_agent_ids, ["flight", "hotel"]);
  assert.equal(result.reason, "permission_blocked");
});

await t("partial input gate stays awaiting_user_input", () => {
  const result = inputAdvancement(
    mission("mission_3", "awaiting_user_input", {
      required_inputs: ["departure_city", "traveler_count"],
    }),
    { departure_city: "San Francisco" },
  );
  assert.equal(result.complete, false);
  assert.equal(result.next_state, "awaiting_user_input");
  assert.equal(result.reason, "required_inputs_missing");
  assert.deepEqual(result.merged_inputs, { departure_city: "San Francisco" });
});

await t("complete input gate advances state and preserves prior answers", () => {
  const result = inputAdvancement(
    mission("mission_4", "awaiting_user_input", {
      required_inputs: ["departure_city", "traveler_count"],
      input_answers: { departure_city: "San Francisco" },
    }),
    { traveler_count: 1 },
  );
  assert.equal(result.complete, true);
  assert.equal(result.next_state, "ready");
  assert.deepEqual(result.merged_inputs, {
    departure_city: "San Francisco",
    traveler_count: 1,
  });
  assert.equal(result.merged_plan.input_answers.traveler_count, 1);
  assert.ok(result.merged_plan.input_gate_resolved_at);
});

await t("free-form answer completes question-only missions", () => {
  const result = inputAdvancement(
    mission("mission_5", "awaiting_user_input", {
      user_questions: ["What hotel budget should I use?"],
    }),
    { answer_text: "Use $200 per night near the Strip." },
  );
  assert.equal(result.complete, true);
  assert.equal(result.next_state, "ready");
});

await t("pendingStepIds returns only executable pending rows", () => {
  assert.deepEqual(
    pendingStepIds([
      step("step_1", "mission_1", "google", "pending"),
      step("step_2", "mission_1", "flight", "ready"),
      step("step_3", "mission_1", "hotel", "pending"),
    ]),
    ["step_1", "step_3"],
  );
});

await t("permission resolver emits permission_blocked for half-promoted missions", async () => {
  const db = mockGateDb({
    missions: [
      {
        id: "mission_7",
        user_id: userId(),
        session_id: "session_7",
        state: "awaiting_permissions",
        plan: {},
      },
    ],
    steps: [
      step("step_1", "mission_7", "google", "pending"),
      step("step_2", "mission_7", "flight", "pending"),
    ],
  });
  const result = await resolvePermissionGate(userId(), "google", { db });
  assert.deepEqual(result, {
    missions_checked: 1,
    missions_advanced: 1,
    steps_advanced: 1,
  });
  assert.equal(db.tables.steps[0].status, "ready");
  assert.equal(db.tables.steps[1].status, "pending");
  assert.equal(db.tables.missions[0].state, "awaiting_permissions");
  assert.deepEqual(db.tables.events.map((event) => event.event_type), [
    "permission_resolved",
    "permission_blocked",
  ]);
  assert.deepEqual(db.tables.events[1].payload.blocked_agent_ids, ["flight"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function mission(id, state, plan = {}) {
  return { id, state, plan };
}

function step(id, mission_id, agent_id, status) {
  return { id, mission_id, agent_id, status, inputs: {} };
}

function userId() {
  return "00000000-0000-0000-0000-000000000001";
}

function mockGateDb(seed) {
  const tables = {
    missions: seed.missions.map((row) => ({ ...row })),
    steps: seed.steps.map((row) => ({ ...row })),
    events: [],
  };
  return {
    tables,
    from(table) {
      const query = {
        table,
        filters: [],
        inFilters: [],
        operation: "select",
        updatePayload: null,
        limitCount: undefined,
        select() {
          this.operation = "select";
          return this;
        },
        update(payload) {
          this.operation = "update";
          this.updatePayload = payload;
          return this;
        },
        insert(value) {
          if (this.table === "mission_execution_events") {
            tables.events.push({ ...value, created_at: new Date().toISOString() });
          }
          return Promise.resolve({ error: null });
        },
        eq(column, value) {
          this.filters.push([column, value]);
          return this;
        },
        in(column, values) {
          this.inFilters.push([column, new Set(values)]);
          return this;
        },
        order() {
          return this;
        },
        limit(count) {
          this.limitCount = count;
          return this;
        },
        then(resolve, reject) {
          return this.execute().then(resolve, reject);
        },
        async execute() {
          const rows = this.rows().filter((row) => this.matches(row));
          if (this.operation === "update") {
            for (const row of rows) Object.assign(row, this.updatePayload);
            return { data: null, error: null };
          }
          const data = typeof this.limitCount === "number" ? rows.slice(0, this.limitCount) : rows;
          return { data: data.map((row) => ({ ...row })), error: null };
        },
        rows() {
          if (this.table === "missions") return tables.missions;
          if (this.table === "mission_steps") return tables.steps;
          return [];
        },
        matches(row) {
          for (const [column, value] of this.filters) {
            if (row[column] !== value) return false;
          }
          for (const [column, values] of this.inFilters) {
            if (!values.has(row[column])) return false;
          }
          return true;
        },
      };
      return query;
    },
  };
}
