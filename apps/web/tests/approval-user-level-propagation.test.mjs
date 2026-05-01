/**
 * APPROVAL-USER-LEVEL-PROPAGATION-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/approval-user-level-propagation.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLumoMissionPlan } from "../lib/lumo-mission.ts";
import {
  firstPartyConnectionProviderForAgentId,
  isFirstPartyAgentId,
} from "../lib/session-app-approvals-core.ts";

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

const migration053 = readFileSync("../../db/migrations/053_user_app_approvals.sql", "utf8");
const userApprovals = readFileSync("lib/user-app-approvals.ts", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const missionRoute = readFileSync("app/api/lumo/mission/route.ts", "utf8");
const installRoute = readFileSync("app/api/lumo/mission/install/route.ts", "utf8");
const revokeRoute = readFileSync("app/api/preferences/app-approvals/revoke/route.ts", "utf8");
const USER_ID = "00000000-0000-0000-0000-000000000001";
const registry = makeRegistry();

console.log("\napproval user-level propagation");

t("migration 053 creates user-level first-party approval ledger", () => {
  assert.match(migration053, /create table if not exists public\.user_app_approvals/);
  assert.match(migration053, /user_id uuid not null references public\.profiles\(id\) on delete cascade/);
  assert.match(migration053, /primary key \(user_id, agent_id\)/);
  assert.match(migration053, /connection_provider in \(\s*'duffel'/);
  assert.match(migration053, /revoked_at timestamptz/);
  assert.match(migration053, /enable row level security/);
  assert.match(migration053, /create policy user_app_approvals_select_own/);
  assert.match(migration053, /grant select on public\.user_app_approvals to authenticated/);
});

t("migration backfills latest first-party session approval and extends the RPC", () => {
  assert.match(migration053, /from public\.session_app_approvals/);
  assert.match(migration053, /row_number\(\) over/);
  assert.match(migration053, /agent_id in \(\s*'flight'/);
  assert.match(migration053, /insert into public\.user_app_approvals/);
  assert.match(migration053, /create or replace function public\.connect_first_party_session_app_approval/);
  assert.match(migration053, /revoked_at = null/);
  assert.match(migration053, /insert into public\.session_app_approvals/);
  assert.match(migration053, /grant execute .* to service_role/);
});

t("first-party helper allows Lumo apps only", () => {
  assert.equal(isFirstPartyAgentId("flight"), true);
  assert.equal(isFirstPartyAgentId("lumo-flights"), true);
  assert.equal(isFirstPartyAgentId("google"), false);
  assert.equal(firstPartyConnectionProviderForAgentId("lumo-flights"), "duffel");
  assert.equal(firstPartyConnectionProviderForAgentId("lumo-hotels"), "booking");
  assert.equal(firstPartyConnectionProviderForAgentId("lumo-restaurants"), "opentable");
  assert.equal(firstPartyConnectionProviderForAgentId("lumo-food"), "doordash");
});

t("cross-session first-party approval suppresses the next chat install card", () => {
  const sessionA = buildLumoMissionPlan({
    request: "Book a flight from Chicago to Vegas",
    registry,
    user_id: USER_ID,
    session_id: "session-a",
  });
  assert.deepEqual(sessionA.install_proposals.map((p) => p.agent_id), ["flight"]);

  const sessionB = buildLumoMissionPlan({
    request: "Book a flight from Chicago to Vegas",
    registry,
    user_id: USER_ID,
    session_id: "session-b",
    session_connected_agent_ids: ["flight"],
  });
  assert.equal(sessionB.install_proposals.length, 0);
  assert.deepEqual(sessionB.ready_agents.map((a) => a.agent_id), ["flight"]);
});

t("runtime bootstraps user approvals before mission planning", () => {
  assert.match(userApprovals, /listActiveUserAppApprovals/);
  assert.match(userApprovals, /connectFirstPartySessionAppApproval/);
  assert.match(userApprovals, /mergeSessionAppApprovals/);
  assert.match(orchestrator, /bootstrapUserAppApprovalsForSession\(input\.user_id, input\.session_id\)/);
  assert.match(orchestrator, /mergeSessionAppApprovals\(\s*loadedSessionApprovals,\s*bootstrappedSessionApprovals/s);
  assert.match(missionRoute, /bootstrapUserAppApprovalsForSession\(user_id, session_id\)/);
  assert.match(missionRoute, /mergeSessionAppApprovals\(\s*loadedSessionApprovals,\s*bootstrappedSessionApprovals/s);
  assert.match(installRoute, /connectFirstPartySessionAppApproval/);
});

t("revocation disables future first-party propagation", () => {
  assert.match(revokeRoute, /requireServerUser/);
  assert.match(revokeRoute, /revokeUserAppApproval/);
  assert.match(userApprovals, /\.from\("user_app_approvals"\)/);
  assert.match(userApprovals, /revoked_at: now/);
  assert.match(userApprovals, /\.from\("agent_connections"\)/);
  assert.match(userApprovals, /\.from\("user_agent_installs"\)/);

  const afterRevoke = buildLumoMissionPlan({
    request: "Find another flight to Vegas",
    registry,
    user_id: USER_ID,
    session_id: "session-after-revoke",
  });
  assert.deepEqual(afterRevoke.install_proposals.map((p) => p.agent_id), ["flight"]);
});

t("third-party approvals remain per-session", () => {
  const sessionA = buildLumoMissionPlan({
    request: "Order food delivery tonight",
    registry,
    user_id: USER_ID,
    session_id: "third-party-a",
    session_connected_agent_ids: ["google"],
  });
  assert.equal(sessionA.install_proposals.length, 0);
  assert.deepEqual(sessionA.ready_agents.map((a) => a.agent_id), ["google"]);

  const sessionB = buildLumoMissionPlan({
    request: "Order food delivery tonight",
    registry,
    user_id: USER_ID,
    session_id: "third-party-b",
  });
  assert.deepEqual(sessionB.install_proposals.map((p) => p.agent_id), ["google"]);
  assert.equal(sessionB.install_proposals[0]?.action, "connect_oauth");
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
      google: entry(
        "google",
        "Google Food",
        "food delivery",
        "Order food delivery through a connected partner account.",
        ["food", "order food", "delivery", "takeout"],
        {
          model: "oauth2",
          scopes: [
            { name: "food:read", description: "Browse food options", required: true },
            { name: "food:orders", description: "Place food orders", required: true },
          ],
        },
        ["name", "email", "address"],
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
        food_order: { agent_id: "google" },
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
