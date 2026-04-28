/**
 * Trip optimization regression tests.
 *
 * Run: node --experimental-strip-types tests/trip-optimization.test.mjs
 */

import assert from "node:assert/strict";
import {
  buildTripOptimizationInput,
  optimizeTripCore,
} from "../lib/trip-optimization-core.ts";

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

console.log("\ntrip optimization");

const plan = {
  original_request:
    "I'm going from California to Vegas next Saturday for a week, then returning back to California. Book flights, hotels, cabs, food, events, attractions, and EV charging if I drive.",
  mission_title: "your Vegas trip",
  required_agents: [
    agent("flight", "Lumo Flights", "flights", "Flights"),
    agent("hotel", "Lumo Hotels", "hotels", "Hotels"),
    agent("open-maps", "Open Maps", "maps", "Maps and routes"),
    agent("food", "Lumo Food", "food", "Food delivery"),
    agent("open-events", "Open Events", "events", "Events"),
    agent("open-attractions", "Open Attractions", "attractions", "Attractions"),
    agent("open-ev-charging", "EV Charging", "ev_charging", "EV charging"),
  ],
  unavailable_capabilities: [],
};

await t("builds a sanitized Vegas trip optimization graph", () => {
  const input = buildTripOptimizationInput(plan);
  assert.ok(input);
  assert.equal(input.start_stop_id, "origin");
  assert.equal(input.end_stop_id, "return");
  assert.equal(input.objective, "balanced");
  assert.ok(input.stops.some((stop) => stop.id === "charging"));
  assert.ok(input.stops.some((stop) => stop.id === "events"));
  assert.ok(input.legs.length > input.stops.length);
  assert.doesNotMatch(JSON.stringify(input), /Book flights, hotels, cabs/);
});

await t("falls back locally when optimizer is not configured", async () => {
  const input = buildTripOptimizationInput(plan);
  const result = await optimizeTripCore({
    user_id: "user_123",
    input,
    baseUrl: "",
    authorizationHeader: null,
    fetchImpl: fetch,
    timeoutMs: 50,
    recordUsage: async () => {},
  });
  assert.ok(result);
  assert.equal(result.source, "fallback");
  assert.equal(result.route[0]?.id, "origin");
  assert.equal(result.route.at(-1)?.id, "return");
  assert.ok(result.total_duration_minutes > 0);
});

await t("uses optimizer response when the brain returns a valid route", async () => {
  const input = buildTripOptimizationInput(plan);
  const result = await optimizeTripCore({
    user_id: "user_123",
    input,
    baseUrl: "http://ml.example",
    authorizationHeader: "Bearer token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          objective: "balanced",
          route: [
            stop("origin", "California", 0),
            stop("hotel", "Vegas hotel base", 1),
          ],
          dropped_stop_ids: [],
          total_duration_minutes: 90,
          total_cost_usd: 42,
          total_distance_km: 58,
          solver: "ortools-routing",
          _lumo_summary: "Optimized two stops.",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    timeoutMs: 500,
    recordUsage: async () => {},
  });
  assert.ok(result);
  assert.equal(result.source, "ml");
  assert.equal(result.solver, "ortools-routing");
  assert.equal(result.route[1]?.id, "hotel");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function agent(agent_id, display_name, capability, capability_label) {
  return {
    agent_id,
    display_name,
    capability,
    capability_label,
    state: "not_installed",
  };
}

function stop(id, label, sequence) {
  return {
    id,
    label,
    category: id,
    sequence,
    arrival_minute: sequence * 60,
    departure_minute: sequence * 60 + 30,
    wait_minutes: 0,
  };
}
