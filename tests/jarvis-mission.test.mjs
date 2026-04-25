/**
 * JARVIS mission planner regression tests.
 *
 * Run: node --experimental-strip-types tests/jarvis-mission.test.mjs
 */

import assert from "node:assert/strict";
import { buildJarvisMissionPlan } from "../lib/jarvis-mission.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

const registry = {
  loaded_at: Date.now(),
  agents: {
    flight: entry("flight", "Lumo Flights", "flights", "Search and book flights.", ["search_flights", "book_flight"], {
      model: "none",
    }, ["name", "email", "payment_method_id"], true),
    hotel: entry("hotel", "Lumo Hotels", "hotels", "Search hotels and book rooms.", ["search_hotels", "book_hotel"], {
      model: "none",
    }, ["name", "email", "payment_method_id"], true),
    food: entry("food", "Lumo Food", "food", "Order food delivery.", ["search_food", "place_food_order"], {
      model: "oauth2",
      scopes: [
        { name: "food:read", description: "Browse restaurants", required: true },
        { name: "food:orders", description: "Place orders", required: true },
      ],
    }, ["name", "email", "phone", "address", "payment_method_id"], true),
    maps: entry("open-maps", "Open Maps", "maps", "Plan routes and distances.", ["maps_route"], {
      model: "none",
    }, [], false),
  },
  bridge: {
    tools: [
      { name: "flight_search", description: "Search flights and airfare." },
      { name: "hotel_search", description: "Search hotels and rooms." },
      { name: "food_order", description: "Order food delivery." },
      { name: "maps_route", description: "Plan routes and distance." },
    ],
    routing: {
      flight_search: { agent_id: "flight" },
      hotel_search: { agent_id: "hotel" },
      food_order: { agent_id: "food" },
      maps_route: { agent_id: "open-maps" },
    },
  },
};

console.log("\njarvis mission planner");

t("trip request proposes missing flight, hotel, and map apps", () => {
  const plan = buildJarvisMissionPlan({
    request: "Book flights, hotels and cabs to Vegas next Saturday.",
    registry,
    user_id: "00000000-0000-0000-0000-000000000001",
  });
  const ids = plan.install_proposals.map((p) => p.agent_id).sort();
  assert.deepEqual(ids, ["flight", "hotel", "open-maps"]);
  assert.equal(plan.should_pause_for_permission, true);
  assert.equal(plan.unavailable_capabilities[0]?.capability, "ride_hailing_booking");
});

t("installed apps do not produce proposals", () => {
  const plan = buildJarvisMissionPlan({
    request: "Book flights and hotels to Vegas.",
    registry,
    user_id: "00000000-0000-0000-0000-000000000001",
    installs: [
      install("flight"),
      install("hotel"),
    ],
  });
  assert.equal(plan.install_proposals.length, 0);
  assert.equal(plan.ready_agents.length, 2);
});

t("oauth apps produce connect proposals instead of direct installs", () => {
  const plan = buildJarvisMissionPlan({
    request: "Order food delivery tonight.",
    registry,
    user_id: "00000000-0000-0000-0000-000000000001",
  });
  assert.equal(plan.install_proposals[0]?.agent_id, "food");
  assert.equal(plan.install_proposals[0]?.action, "connect_oauth");
  assert.deepEqual(
    plan.install_proposals[0]?.required_scopes.map((s) => s.name),
    ["food:read", "food:orders"],
  );
});

t("unavailable ride-hailing pauses even when map app is ready", () => {
  const plan = buildJarvisMissionPlan({
    request: "Book me a cab downtown.",
    registry,
    user_id: "00000000-0000-0000-0000-000000000001",
    installs: [install("open-maps")],
  });
  assert.equal(plan.install_proposals.length, 0);
  assert.equal(plan.unavailable_capabilities[0]?.capability, "ride_hailing_booking");
  assert.equal(plan.should_pause_for_permission, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function entry(agent_id, display_name, domain, one_liner, intents, connect, pii_scope, requires_payment) {
  return {
    key: agent_id,
    base_url: `http://localhost/${agent_id}`,
    manifest: {
      agent_id,
      display_name,
      domain,
      one_liner,
      intents,
      example_utterances: [],
      version: "0.1.0",
      openapi_url: `http://localhost/${agent_id}/openapi.json`,
      health_url: `http://localhost/${agent_id}/api/health`,
      ui: { components: [] },
      sla: {
        p50_latency_ms: 100,
        p95_latency_ms: 500,
        availability_target: 0.99,
      },
      pii_scope,
      requires_payment,
      supported_regions: ["US"],
      capabilities: {
        sdk_version: "0.1.0",
        supports_compound_bookings: false,
        implements_cancellation: false,
      },
      connect,
    },
    openapi: {},
    last_health: null,
    health_score: 1,
    manifest_loaded_at: Date.now(),
  };
}

function install(agent_id) {
  return {
    user_id: "00000000-0000-0000-0000-000000000001",
    agent_id,
    status: "installed",
    permissions: {},
    install_source: "marketplace",
    installed_at: new Date().toISOString(),
    revoked_at: null,
    last_used_at: null,
    updated_at: new Date().toISOString(),
  };
}
