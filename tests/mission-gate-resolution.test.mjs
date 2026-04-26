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
    complete: false,
    next_state: "awaiting_permissions",
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
    complete: true,
    next_state: "ready",
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
  assert.equal(wrongAgent.reason, "no_matching_pending_steps");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function mission(id, state, plan = {}) {
  return { id, state, plan };
}

function step(id, mission_id, agent_id, status) {
  return { id, mission_id, agent_id, status, inputs: {} };
}
