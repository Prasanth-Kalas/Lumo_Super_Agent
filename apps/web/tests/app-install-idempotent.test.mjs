/**
 * APP-INSTALL-IDEMPOTENT-2 regression suite.
 *
 * Run: node --experimental-strip-types tests/app-install-idempotent.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLumoMissionPlan } from "../lib/lumo-mission.ts";
import { sessionApprovalIdempotencyKey } from "../lib/session-app-approvals-core.ts";

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

const migration050 = readFileSync("../../db/migrations/050_session_app_approvals.sql", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const missionRoute = readFileSync("app/api/lumo/mission/route.ts", "utf8");
const installRoute = readFileSync("app/api/lumo/mission/install/route.ts", "utf8");
const lumoMissionCard = readFileSync("components/LumoMissionCard.tsx", "utf8");
const USER_ID = "00000000-0000-0000-0000-000000000001";
const registry = makeRegistry();

console.log("\napp install idempotency");

t("migration declares per-session approval uniqueness", () => {
  assert.match(migration050, /create table if not exists public\.session_app_approvals/);
  assert.match(migration050, /primary key \(session_id, agent_id\)/);
  assert.match(migration050, /granted_scopes text\[\] not null default '\{\}'::text\[\]/);
  assert.match(migration050, /drop column revoked_at/);
});

t("approval idempotency key is stable per session + agent", () => {
  const a = sessionApprovalIdempotencyKey("session-a", "flight");
  assert.equal(a, sessionApprovalIdempotencyKey("session-a", "flight"));
  assert.notEqual(a, sessionApprovalIdempotencyKey("session-b", "flight"));
  assert.notEqual(a, sessionApprovalIdempotencyKey("session-a", "hotel"));
  assert.match(a, /^[a-f0-9]{32}$/);
});

t("3-turn session skips previously approved app cards", () => {
  const turn1 = buildLumoMissionPlan({
    request: "Can you book a flight from Chicago to Vegas?",
    registry,
    user_id: USER_ID,
    session_id: "session-demo",
  });
  assert.deepEqual(turn1.install_proposals.map((p) => p.agent_id), ["flight"]);
  assert.ok(turn1.install_proposals[0]?.approval_idempotency_key);

  const turn2 = buildLumoMissionPlan({
    request: "Book flights and hotels to Vegas.",
    registry,
    user_id: USER_ID,
    session_id: "session-demo",
    session_connected_agent_ids: ["flight"],
  });
  assert.deepEqual(turn2.install_proposals.map((p) => p.agent_id), ["hotel"]);
  assert.equal(turn2.install_proposals.some((p) => p.agent_id === "flight"), false);

  const turn3 = buildLumoMissionPlan({
    request: "Find another flight option for Vegas.",
    registry,
    user_id: USER_ID,
    session_id: "session-demo",
    session_connected_agent_ids: ["flight"],
  });
  assert.equal(turn3.install_proposals.length, 0);
  assert.deepEqual(turn3.ready_agents.map((agent) => agent.agent_id), ["flight"]);
});

t("orchestrator loads session approvals before planning", () => {
  assert.match(orchestrator, /listSessionAppApprovals/);
  assert.match(orchestrator, /sessionConnectedAgentIds/);
  assert.match(orchestrator, /session_connected_agent_ids: Array\.from\(sessionConnectedAgentIds\)/);
  assert.match(missionRoute, /listSessionAppApprovals/);
  assert.match(missionRoute, /session_connected_agent_ids: Array\.from\(sessionConnectedAgentIds\)/);
});

t("mission install route persists session approval and verifies card key", () => {
  assert.match(installRoute, /upsertSessionAppApproval/);
  assert.match(installRoute, /approval_idempotency_key_mismatch/);
  assert.match(installRoute, /session_approval/);
  assert.match(lumoMissionCard, /approval_idempotency_key: proposal\.approval_idempotency_key/);
  assert.match(lumoMissionCard, /session_id: plan\.session_id/);
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
      hotel: entry(
        "hotel",
        "Lumo Hotels",
        "hotels",
        "Search hotels and book rooms.",
        ["search_hotels", "book_hotel"],
        { model: "none" },
        ["name", "email", "payment_method_id"],
        true,
      ),
    },
    bridge: {
      tools: [
        { name: "flight_search", description: "Search flights and airfare." },
        { name: "hotel_search", description: "Search hotels and rooms." },
      ],
      routing: {
        flight_search: { agent_id: "flight" },
        hotel_search: { agent_id: "hotel" },
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
