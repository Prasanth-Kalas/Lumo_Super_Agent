/**
 * APP-INSTALL-CONNECTION-IDEMPOTENT-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/app-install-connection-idempotent.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLumoMissionPlan } from "../lib/lumo-mission.ts";
import { isFirstPartyLumoApp } from "../lib/session-app-approvals-core.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.stack ?? e.message}`);
  }
};

const migration051 = readFileSync(
  "../../db/migrations/051_session_app_approval_connections.sql",
  "utf8",
);
const sessionApprovals = readFileSync("lib/session-app-approvals.ts", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const missionRoute = readFileSync("app/api/lumo/mission/route.ts", "utf8");
const installRoute = readFileSync("app/api/lumo/mission/install/route.ts", "utf8");
const router = readFileSync("lib/router.ts", "utf8");
const USER_ID = "00000000-0000-0000-0000-000000000001";
const registry = makeRegistry();

console.log("\napp install connection idempotency");

t("migration 051 adds session connection columns and atomic first-party RPC", () => {
  assert.match(migration051, /add column if not exists connected_at timestamptz/);
  assert.match(migration051, /add column if not exists connection_provider text/);
  assert.match(migration051, /create or replace function public\.connect_first_party_session_app_approval/);
  assert.match(migration051, /insert into public\.agent_connections/);
  assert.match(migration051, /on conflict \(session_id, agent_id\) do update/);
  assert.match(migration051, /grant execute .* to service_role/);
});

t("first-party detector is explicit and does not bless generic partners", () => {
  assert.equal(
    isFirstPartyLumoApp({ agent_id: "flight", display_name: "Lumo Flights" }),
    true,
  );
  assert.equal(
    isFirstPartyLumoApp({ agent_id: "lumo-hotels", display_name: "Anything" }),
    true,
  );
  assert.equal(
    isFirstPartyLumoApp({ agent_id: "partner-flight", display_name: "Partner Flights" }),
    false,
  );
});

t("4-turn flight flow stays connected after approval and never re-prompts", () => {
  const turn1 = buildLumoMissionPlan({
    request: "Can you book a flight from Chicago to Vegas?",
    registry,
    user_id: USER_ID,
    session_id: "session-vegas",
  });
  assert.deepEqual(turn1.install_proposals.map((proposal) => proposal.agent_id), ["flight"]);

  const connected = ["flight"];
  const followUps = [
    "For that flight, make it roundtrip and one passenger.",
    "Search Duffel flights from Chicago to Vegas for next Friday.",
    "Book the cheapest flight now.",
  ];
  for (const request of followUps) {
    const plan = buildLumoMissionPlan({
      request,
      registry,
      user_id: USER_ID,
      session_id: "session-vegas",
      session_connected_agent_ids: connected,
    });
    assert.equal(plan.install_proposals.length, 0, request);
    assert.equal(
      plan.ready_agents.some((agent) => agent.agent_id === "flight"),
      true,
      request,
    );
  }
});

t("approved-but-not-connected rows do not unlock booking dispatch", () => {
  const plan = buildLumoMissionPlan({
    request: "Find another flight option for Vegas.",
    registry,
    user_id: USER_ID,
    session_id: "session-vegas",
  });
  assert.deepEqual(plan.install_proposals.map((proposal) => proposal.agent_id), ["flight"]);
});

t("connected first-party OAuth app is ready without marketplace redirect", () => {
  const plan = buildLumoMissionPlan({
    request: "Order food delivery tonight.",
    registry,
    user_id: USER_ID,
    session_id: "session-food",
    session_connected_agent_ids: ["food"],
  });
  assert.equal(plan.install_proposals.length, 0);
  assert.deepEqual(plan.ready_agents.map((agent) => agent.agent_id), ["food"]);
});

t("runtime code reads connected_at rather than raw approval rows", () => {
  assert.match(sessionApprovals, /connectedAgentIdsFromSessionApprovals/);
  assert.match(sessionApprovals, /approval\.connected_at !== null/);
  assert.match(orchestrator, /sessionConnectedAgentIds/);
  assert.match(orchestrator, /session_connected_agent_ids: Array\.from\(sessionConnectedAgentIds\)/);
  assert.match(missionRoute, /sessionConnectedAgentIds/);
  assert.match(installRoute, /connectFirstPartySessionAppApproval/);
  assert.match(installRoute, /isFirstPartyLumoApp/);
  assert.match(router, /getConnectedSessionAppApproval/);
  assert.match(router, /has_active_connection: connectionId !== null \|\| hasSessionConnection/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function makeRegistry() {
  return {
    loaded_at: Date.now(),
    agents: {
      flight: entry(
        "flight",
        "Lumo Flights",
        "flights",
        "Search and book flights.",
        ["search_flights", "book_flight"],
        { model: "none" },
        ["name", "email", "payment_method_id"],
        true,
      ),
      food: entry(
        "food",
        "Lumo Food",
        "food",
        "Order food delivery.",
        ["search_food", "place_food_order"],
        {
          model: "oauth2",
          scopes: [
            { name: "food:read", description: "Browse restaurants", required: true },
            { name: "food:orders", description: "Place orders", required: true },
          ],
        },
        ["name", "email", "phone", "address", "payment_method_id"],
        true,
      ),
    },
    bridge: {
      tools: [
        { name: "flight_search", description: "Search flights and airfare." },
        { name: "food_order", description: "Order food delivery." },
      ],
      routing: {
        flight_search: { agent_id: "flight" },
        food_order: { agent_id: "food" },
      },
    },
  };
}

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
