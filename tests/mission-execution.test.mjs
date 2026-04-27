/**
 * Durable mission execution substrate tests.
 *
 * Run: node --experimental-strip-types tests/mission-execution.test.mjs
 */

import assert from "node:assert/strict";
import {
  planToMissionRows,
  transition,
  validNextStates,
} from "../lib/mission-execution-core.ts";
import { persistMission, recordExecutionEvent } from "../lib/mission-execution.ts";

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

const transitions = {
  draft: ["awaiting_permissions", "awaiting_user_input", "ready", "failed", "rolled_back"],
  awaiting_permissions: ["awaiting_user_input", "ready", "failed", "rolling_back", "rolled_back"],
  awaiting_user_input: ["awaiting_permissions", "ready", "failed", "rolling_back"],
  ready: ["executing", "awaiting_confirmation", "failed", "rolling_back"],
  executing: ["awaiting_confirmation", "completed", "failed", "rolling_back"],
  awaiting_confirmation: ["executing", "completed", "failed", "rolling_back"],
  rolling_back: ["rolled_back", "failed"],
  completed: ["rolling_back"],
  failed: ["rolling_back", "rolled_back"],
  rolled_back: [],
};
const states = Object.keys(transitions);

console.log("\nmission execution");

await t("validNextStates exposes every allowed transition", () => {
  for (const [state, next] of Object.entries(transitions)) {
    assert.deepEqual(validNextStates(state), next);
    for (const target of next) {
      assert.deepEqual(transition(state, target), { ok: true });
    }
  }
});

await t("invalid state transitions are rejected", () => {
  for (const current of states) {
    for (const target of states) {
      if (transitions[current].includes(target)) continue;
      const result = transition(current, target);
      assert.equal(result.ok, false, `${current} -> ${target} should be invalid`);
      assert.ok(result.reason);
    }
  }
});

await t("planToMissionRows maps all-reversible plans", () => {
  const plan = missionPlan({
    required_agents: [
      agent("open-maps", "Open Maps", "maps", "Maps and routes", {
        one_liner: "Plan routes and distances.",
        state: "ready",
      }),
      agent("open-weather", "Open Weather", "weather", "Weather", {
        one_liner: "Read weather forecasts.",
        state: "ready",
      }),
    ],
    ready_agents: [],
    can_continue_now: true,
  });
  const rows = planToMissionRows(plan, userId(), "session_1");
  assert.equal(rows.mission.state, "ready");
  assert.deepEqual(rows.steps.map((s) => s.reversibility), [
    "reversible",
    "reversible",
  ]);
  assert.deepEqual(rows.steps.map((s) => s.tool_name), [
    "mission.maps",
    "mission.weather",
  ]);
  assert.deepEqual(rows.steps.map((s) => s.status), ["ready", "ready"]);
});

await t("planToMissionRows maps irreversible booking/payment plans", () => {
  const plan = missionPlan({
    required_agents: [
      agent("flight", "Lumo Flights", "flights", "Flights", {
        one_liner: "Search, price, and book flights worldwide.",
        requires_payment: true,
      }),
      agent("hotel", "Lumo Hotels", "hotels", "Hotels", {
        one_liner: "Book hotel rooms.",
        requires_payment: true,
      }),
    ],
    user_questions: ["How many travelers should I plan for?"],
  });
  const rows = planToMissionRows(plan, userId(), "session_2");
  assert.equal(rows.mission.state, "awaiting_user_input");
  assert.deepEqual(rows.steps.map((s) => s.reversibility), [
    "irreversible",
    "irreversible",
  ]);
});

await t("planToMissionRows maps mixed reversibility", () => {
  const plan = missionPlan({
    required_agents: [
      agent("open-maps", "Open Maps", "maps", "Maps and routes", {
        one_liner: "Plan routes.",
        state: "ready",
      }),
      agent("food", "Lumo Food", "food", "Food delivery", {
        one_liner: "Place delivery orders.",
        requires_payment: true,
        state: "not_connected",
      }),
      agent("gmail", "Google Gmail", "email", "Email", {
        one_liner: "Send email messages.",
        state: "ready",
      }),
    ],
    install_proposals: [
      proposal("food", "Lumo Food", "food", "Food delivery", {
        action: "connect_oauth",
        requires_payment: true,
        state: "not_connected",
      }),
    ],
    should_pause_for_permission: true,
  });
  const rows = planToMissionRows(plan, userId(), "session_3");
  assert.equal(rows.mission.state, "awaiting_permissions");
  assert.deepEqual(rows.steps.map((s) => s.reversibility), [
    "reversible",
    "irreversible",
    "compensating",
  ]);
  assert.deepEqual(rows.steps.map((s) => s.status), [
    "ready",
    "pending",
    "ready",
  ]);
  assert.equal(rows.steps[1].inputs.install_action, "connect_oauth");
});

await t("persistMission writes one mission and ordered steps", async () => {
  const db = mockDb();
  const plan = missionPlan({
    required_agents: [
      agent("open-maps", "Open Maps", "maps", "Maps and routes", {
        state: "ready",
      }),
      agent("flight", "Lumo Flights", "flights", "Flights", {
        requires_payment: true,
      }),
    ],
  });
  const result = await persistMission(plan, userId(), "session_4", { db });
  assert.deepEqual(result, {
    mission_id: "mission_db_1",
    step_count: 2,
    persisted: true,
  });
  assert.equal(db.inserts.length, 2);
  assert.equal(db.inserts[0].table, "missions");
  assert.equal(db.inserts[0].values.intent_text, plan.original_request);
  assert.equal(db.inserts[1].table, "mission_steps");
  assert.deepEqual(
    db.inserts[1].values.map((step) => [step.mission_id, step.step_order, step.agent_id]),
    [
      ["mission_db_1", 0, "open-maps"],
      ["mission_db_1", 1, "flight"],
    ],
  );
  assert.deepEqual(db.inserts[1].values.map((step) => step.status), [
    "ready",
    "pending",
  ]);
});

await t("recordExecutionEvent writes event payloads", async () => {
  const db = mockDb();
  await recordExecutionEvent(
    {
      mission_id: "mission_db_1",
      step_id: "step_1",
      event_type: "step_started",
      payload: { tool_name: "mission.maps" },
    },
    { db },
  );
  assert.equal(db.inserts[0].table, "mission_execution_events");
  assert.deepEqual(db.inserts[0].values, {
    mission_id: "mission_db_1",
    step_id: "step_1",
    event_type: "step_started",
    payload: { tool_name: "mission.maps" },
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function missionPlan(overrides = {}) {
  const required_agents = overrides.required_agents ?? [];
  return {
    mission_id: "mission_seed",
    original_request: "Plan my trip.",
    mission_title: "this task",
    message: "Mission ready.",
    required_agents,
    ready_agents: overrides.ready_agents ?? required_agents.filter((a) => a.state === "ready"),
    install_proposals: overrides.install_proposals ?? [],
    ranked_recommendations: [],
    trip_optimization: null,
    user_questions: overrides.user_questions ?? [],
    confirmation_points: ["Confirm before side effects."],
    unavailable_capabilities: [],
    can_continue_now: overrides.can_continue_now ?? false,
    should_pause_for_permission: overrides.should_pause_for_permission ?? false,
  };
}

function agent(agent_id, display_name, capability, capability_label, overrides = {}) {
  return {
    agent_id,
    display_name,
    one_liner: overrides.one_liner ?? `${display_name} capability.`,
    domain: overrides.domain ?? capability,
    capability,
    capability_label,
    confidence: 0.9,
    reason: overrides.reason ?? `The request asks for ${capability_label}.`,
    marketplace_url: `/marketplace/${agent_id}`,
    connect_model: overrides.connect_model ?? "none",
    required_scopes: overrides.required_scopes ?? [],
    pii_scope: overrides.pii_scope ?? [],
    requires_payment: overrides.requires_payment ?? false,
    health_score: 1,
    rank_score: null,
    rank_reasons: [],
    risk_badge: null,
    state: overrides.state ?? "not_installed",
    state_reason: overrides.state_reason ?? "Ready for test.",
  };
}

function proposal(agent_id, display_name, capability, capability_label, overrides = {}) {
  return {
    ...agent(agent_id, display_name, capability, capability_label, overrides),
    action: overrides.action ?? "install",
    can_auto_install: overrides.action !== "connect_oauth",
    permission_title: `Install ${display_name}`,
    permission_copy: "Test permission.",
    profile_fields_requested: overrides.pii_scope ?? [],
  };
}

function mockDb() {
  const db = {
    inserts: [],
    from(table) {
      return {
        insert(values) {
          db.inserts.push({ table, values });
          if (table === "missions") {
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: "mission_db_1" }, error: null };
                  },
                };
              },
            };
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return db;
}

function userId() {
  return "00000000-0000-0000-0000-000000000001";
}
