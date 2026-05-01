/**
 * COMPOUND-MISSION-ROUTING-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/compound-mission-routing.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyIntent,
  detectCompoundTripIntent,
  normalizeClassifierPayload,
} from "../lib/perf/intent-classifier.ts";
import {
  buildCompoundMissionCreatePayload,
  canonicalizeCompoundMissionPlan,
  compoundMissionPlanHash,
  normalizeCompoundMissionPlan,
  planCompoundMission,
} from "../lib/compound/mission-planner.ts";
import { normalizeCompoundCreatePayload } from "../lib/compound/persistence.ts";

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

console.log("\ncompound mission routing");

const classifier = readFileSync("lib/perf/intent-classifier.ts", "utf8");
const planner = readFileSync("lib/compound/mission-planner.ts", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");

await t("classifier accepts compound_trip as an orthogonal reasoning-path signal", async () => {
  const parsed = normalizeClassifierPayload(
    '{"bucket":"compound_trip","is_compound_trip":true,"confidence":0.94,"reasoning":"multi-leg trip"}',
    { provider: "groq", model: "llama-test", latencyMs: 12 },
  );
  assert.equal(parsed.bucket, "reasoning_path");
  assert.equal(parsed.isCompoundTrip, true);
  assert.match(classifier, /compound_trip/);
  assert.match(classifier, /is_compound_trip/);
});

await t("compound-trip heuristic catches multi-leg travel and ignores single-agent flight requests", () => {
  assert.equal(detectCompoundTripIntent("Plan a Vegas weekend with hotel"), true);
  assert.equal(
    detectCompoundTripIntent("Going to Vegas next month, need flights + dinner reservation"),
    true,
  );
  assert.equal(detectCompoundTripIntent("Book flights, hotel, dinner, and ride in one flow"), true);
  assert.equal(detectCompoundTripIntent("Book a flight to Vegas"), false);
  assert.equal(detectCompoundTripIntent("Quick trip to Chicago"), false);
});

await t("classifyIntent marks natural compound trip phrasing without changing timing bucket enum", async () => {
  const result = await classifyIntent(
    {
      messages: [{ role: "user", content: "Plan a Vegas weekend with hotel" }],
      toolCount: 12,
      installedAgentCount: 4,
      connectedAgentCount: 4,
      hasPriorSummary: false,
      mode: "text",
    },
    {
      fetchImpl: fixtureClassifier("reasoning_path", false),
      providers: [
        {
          provider: "groq",
          baseUrl: "https://example.test/chat",
          apiKey: "test",
          model: "llama-test",
        },
      ],
    },
  );
  assert.equal(result.bucket, "reasoning_path");
  assert.equal(result.isCompoundTrip, true);
});

await t("planner normalizes allowed agents, dependencies, and rejects unsupported agents", () => {
  const plan = normalizeCompoundMissionPlan(makePlan());
  assert.ok(plan);
  assert.equal(plan.legs.length, 3);
  assert.deepEqual(
    plan.legs.map((leg) => leg.agent_id),
    ["lumo-flights", "lumo-hotels", "lumo-restaurants"],
  );
  assert.equal(
    normalizeCompoundMissionPlan({
      ...makePlan(),
      legs: [
        ...makePlan().legs,
        {
          client_leg_id: "ride",
          agent_id: "lumo-unsupported",
          description: "Booking ride",
          line_items_hint: {},
        },
      ],
    }),
    null,
  );
});

await t("five natural-language compound requests produce valid acyclic graphs through the planner seam", async () => {
  for (const message of [
    "Plan a Vegas weekend with flights, hotel, and dinner",
    "Going to Vegas next month, need flights + dinner reservation",
    "Put together a Miami trip with a hotel and food for Friday",
    "Arrange New York flights, hotel, and ground transport",
    "Book the whole Vegas itinerary: flight, hotel, restaurant",
  ]) {
    const plan = await planCompoundMission(message, {
      complete: async () => JSON.stringify(makePlan(message)),
    });
    assert.ok(plan, message);
    const payload = buildCompoundMissionCreatePayload(plan, "session-test");
    const normalized = normalizeCompoundCreatePayload(payload);
    assert.equal(normalized.replay_plan.graph_valid, true);
    assert.equal(normalized.legs.length >= 2, true);
  }
});

await t("cyclic planner output is rejected before persistence payload construction", () => {
  const cyclic = normalizeCompoundMissionPlan({
    ...makePlan(),
    dependencies: [
      {
        dependency_leg_id: "flight",
        dependent_leg_id: "hotel",
        edge_type: "requires_destination",
      },
      {
        dependency_leg_id: "hotel",
        dependent_leg_id: "flight",
        edge_type: "custom",
      },
    ],
  });
  assert.equal(cyclic, null);
});

await t("same semantic plan produces stable graph hash after canonical sorting", () => {
  const a = normalizeCompoundMissionPlan(makePlan());
  const b = normalizeCompoundMissionPlan({
    announcement: "I kicked off the Vegas plan.",
    legs: makePlan().legs.slice().reverse(),
    dependencies: makePlan().dependencies.slice().reverse(),
  });
  assert.ok(a);
  assert.ok(b);
  assert.deepEqual(canonicalizeCompoundMissionPlan(a).legs, canonicalizeCompoundMissionPlan(b).legs);
  assert.deepEqual(
    canonicalizeCompoundMissionPlan(a).dependencies,
    canonicalizeCompoundMissionPlan(b).dependencies,
  );
  assert.equal(compoundMissionPlanHash(a), compoundMissionPlanHash(b));
  assert.equal(
    normalizeCompoundCreatePayload(buildCompoundMissionCreatePayload(a, "session-hash")).graph_hash,
    normalizeCompoundCreatePayload(buildCompoundMissionCreatePayload(b, "session-hash")).graph_hash,
  );
});

await t("single-agent flight requests stay out of compound planner path", async () => {
  const result = await classifyIntent(
    {
      messages: [{ role: "user", content: "Book a flight to Vegas" }],
      toolCount: 12,
      installedAgentCount: 4,
      connectedAgentCount: 4,
      hasPriorSummary: false,
      mode: "text",
    },
    {
      fetchImpl: fixtureClassifier("tool_path", false),
      providers: [
        {
          provider: "groq",
          baseUrl: "https://example.test/chat",
          apiKey: "test",
          model: "llama-test",
        },
      ],
    },
  );
  assert.equal(result.bucket, "tool_path");
  assert.equal(result.isCompoundTrip, false);
});

await t("orchestrator uses the planner path instead of hard-wired phrase detection", () => {
  assert.match(orchestrator, /maybeCreateCompoundMissionDispatch/);
  assert.doesNotMatch(orchestrator, /maybeCreateVegasWeekendCompoundDispatch/);
  assert.doesNotMatch(orchestrator, /demo:vegas-weekend/);
  assert.match(planner, /replayCompoundTransaction/);
  assert.match(planner, /createCompoundTransaction/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

function fixtureClassifier(bucket, isCompoundTrip) {
  return async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              bucket,
              is_compound_trip: isCompoundTrip,
              confidence: 0.95,
              reasoning: `fixture:${bucket}`,
            }),
          },
        },
      ],
    });
}

function makePlan(message = "Plan a Vegas weekend with flights, hotel, and dinner") {
  return {
    announcement: "I kicked off the Vegas plan. I’ll track each specialist agent as it works.",
    legs: [
      {
        client_leg_id: "flight",
        agent_id: "lumo-flights",
        description: "Booking flight ORD → LAS",
        line_items_hint: { route: "ORD-LAS", source: message },
      },
      {
        client_leg_id: "hotel",
        agent_id: "lumo-hotels",
        description: "Booking hotel near the Strip",
        line_items_hint: { area: "Las Vegas Strip" },
      },
      {
        client_leg_id: "restaurant",
        agent_id: "lumo-restaurants",
        description: "Booking dinner reservation",
        line_items_hint: { party_size: 1 },
      },
    ],
    dependencies: [
      {
        dependency_leg_id: "flight",
        dependent_leg_id: "hotel",
        edge_type: "requires_destination",
      },
      {
        dependency_leg_id: "hotel",
        dependent_leg_id: "restaurant",
        edge_type: "requires_arrival_time",
      },
    ],
  };
}
