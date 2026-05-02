/**
 * ORCHESTRATOR-COMPOUND-DISPATCH-WIRE-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/orchestrator-compound-dispatch-wire.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCompoundMissionPlan,
  buildCompoundMissionPlanWithConfirmation,
  detectCompoundMissionIntent,
  validateCompoundMissionPlan,
} from "../lib/compound/mission-planner.ts";
import {
  buildAssistantCompoundDispatchFrameFromMissionPlan,
} from "../lib/compound/dispatch-frame.ts";

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

console.log("\norchestrator compound dispatch wire");

const now = new Date("2026-05-02T00:00:00Z");
const migration061 = readFileSync(
  "../../db/migrations/061_compound_mission_dispatch.sql",
  "utf8",
);
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const missionDispatch = readFileSync("lib/compound/mission-dispatch.ts", "utf8");
const missionExecutor = readFileSync("lib/mission-executor.ts", "utf8");
const page = readFileSync("app/page.tsx", "utf8");
const historyReplay = readFileSync("lib/history-replay.ts", "utf8");
const events = readFileSync("lib/events.ts", "utf8");

await t("migration 061 adds mission DAG columns and step-update frame type", () => {
  assert.match(migration061, /alter table public\.missions[\s\S]*compound_dispatch_id/);
  assert.match(migration061, /alter table public\.mission_steps[\s\S]*client_step_id/);
  assert.match(migration061, /depends_on_step_orders integer\[\]/);
  assert.match(migration061, /assistant_compound_step_update/);
  assert.match(migration061, /next_mission_step_for_execution/);
});

await t("five canonical compound prompts produce valid multi-leg plans", () => {
  const cases = [
    {
      text: "plan a trip from chicago to vegas next entire week including hotels",
      expectedAgents: ["lumo-flights", "lumo-hotels"],
    },
    {
      text: "Going to Vegas next month, need flights and dinner reservation",
      expectedAgents: ["lumo-flights", "lumo-restaurants"],
    },
    {
      text: "Plan a Paris food tour from Chicago with restaurants",
      expectedAgents: ["lumo-flights", "lumo-restaurants"],
    },
    {
      text: "Plan a beach getaway from Chicago with hotel and flight",
      expectedAgents: ["lumo-flights", "lumo-hotels"],
    },
    {
      text: "Plan a ski week from Chicago with lodging and dinner",
      expectedAgents: ["lumo-flights", "lumo-hotels", "lumo-restaurants"],
    },
  ];

  for (const item of cases) {
    const plan = buildCompoundMissionPlan({ message: item.text, now });
    assert.ok(plan, item.text);
    assert.ok(plan.legs.length >= 2, item.text);
    assert.ok(plan.legs.length <= 4, item.text);
    validateCompoundMissionPlan({
      legs: plan.legs,
      dependencies: plan.dependencies,
    });
    for (const agentId of item.expectedAgents) {
      assert.ok(
        plan.legs.some((leg) => leg.agent_id === agentId),
        `${item.text} missing ${agentId}`,
      );
    }
  }
});

await t("single-agent prompts do not route into the compound planner", () => {
  assert.equal(detectCompoundMissionIntent("Book a flight to Vegas").compound, false);
  assert.equal(detectCompoundMissionIntent("Show me food options nearby").compound, false);
  assert.equal(detectCompoundMissionIntent("Quick trip to Chicago").compound, false);
  assert.equal(
    buildCompoundMissionPlan({ message: "Book a flight to Vegas", now }),
    null,
  );
});

await t("normalized graph hash is deterministic for equivalent planner input", () => {
  const a = buildCompoundMissionPlan({
    message: "plan a trip from chicago to vegas next entire week including hotels",
    now,
  });
  const b = buildCompoundMissionPlan({
    message: "plan a trip from chicago to vegas next entire week including hotels",
    now,
  });
  assert.ok(a && b);
  assert.equal(a.graph_hash, b.graph_hash);
});

await t("ambiguous compound shortlist can be confirmed by the LLM tiebreaker", async () => {
  const plan = await buildCompoundMissionPlanWithConfirmation(
    { message: "flight hotel vegas next week", now },
    {
      providers: [
        {
          provider: "groq",
          baseUrl: "https://example.invalid/openai/v1/chat/completions",
          apiKey: "test",
          model: "test-model",
        },
      ],
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decision: "compound",
                    confidence: 0.92,
                    domains: ["flights", "hotels"],
                    reason: "The request asks for both flight and hotel planning.",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  );
  assert.ok(plan);
  assert.equal(plan.source, "heuristic_llm_confirmed");
  assert.deepEqual(
    plan.legs.map((leg) => leg.agent_id).sort(),
    ["lumo-flights", "lumo-hotels"],
  );
});

await t("mission plan dispatch frame projects mission legs as compound UI rows", () => {
  const plan = buildCompoundMissionPlan({
    message: "plan a trip from chicago to vegas next entire week including hotels",
    now,
  });
  assert.ok(plan);
  const frame = buildAssistantCompoundDispatchFrameFromMissionPlan(plan, "mission:demo");
  assert.equal(frame.kind, "assistant_compound_dispatch");
  assert.equal(frame.compound_transaction_id, "mission:demo");
  assert.deepEqual(
    frame.legs.map((leg) => leg.leg_id),
    plan.legs.map((leg) => leg.client_step_id),
  );
  assert.ok(frame.legs.every((leg) => leg.status === "pending"));
  assert.deepEqual(
    frame.legs.find((leg) => leg.leg_id === "hotel_search")?.depends_on,
    ["flight_search"],
  );
});

await t("mission step mapping replaces mission.* no-op acknowledgements", () => {
  assert.match(missionDispatch, /\["mission\.flight_search", "duffel_search_flights"\]/);
  assert.match(missionDispatch, /\["mission\.hotel_search", "hotel_search"\]/);
  assert.match(
    missionDispatch,
    /\["mission\.restaurant_search", "restaurant_check_availability"\]/,
  );
  assert.match(missionDispatch, /Unsupported mission step tool/);
  assert.match(missionDispatch, /No registered dispatch tool/);
  assert.doesNotMatch(missionExecutor, /status:\s*["']acknowledged["']/);
});

await t("orchestrator emits real compound dispatch frames and waits for mission outputs", () => {
  assert.match(orchestrator, /buildCompoundMissionPlan/);
  assert.match(orchestrator, /persistCompoundMissionPlan/);
  assert.match(orchestrator, /runCompoundMissionInline/);
  assert.match(orchestrator, /assistant_compound_dispatch/);
  assert.match(orchestrator, /assistant_compound_step_update/);
  assert.doesNotMatch(orchestrator, /maybeCreateVegasWeekendCompoundDispatch/);
});

await t("web shell and replay consume assistant_compound_step_update frames", () => {
  assert.match(events, /"assistant_compound_step_update"/);
  assert.match(page, /frame\.type === "assistant_compound_step_update"/);
  assert.match(page, /applyCompoundStepUpdateToUI/);
  assert.match(historyReplay, /event\.frame_type === "assistant_compound_step_update"/);
  assert.match(historyReplay, /applyCompoundStepUpdate/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
