/**
 * MESH-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/mesh-substrate.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DuffelClient } from "../lib/agents/duffel/client.ts";
import { projectOffer, searchOffers } from "../lib/agents/duffel/flight-search.ts";
import { createHold } from "../lib/agents/duffel/flight-hold.ts";
import { DUFFEL_FLIGHT_AGENT_MANIFEST } from "../lib/agents/duffel/manifest.ts";
import { planSubagentsForTurn } from "../lib/mesh/dispatch-planner.ts";
import { SubAgent } from "../lib/mesh/subagent-base.ts";
import { SupervisorOrchestrator } from "../lib/mesh/supervisor.ts";
import { extractIntentSlots } from "../lib/mesh/subagents/intent-deep.ts";

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

console.log("\nmesh-1 substrate");

const migration045 = readFileSync("../../db/migrations/045_mesh_subagent_calls.sql", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const integrationRegistry = readFileSync("lib/integrations/registry.ts", "utf8");

await t("migration 045 declares subagent_calls with append-only evidence", () => {
  assert.match(migration045, /create table if not exists public\.subagent_calls/);
  for (const column of [
    "request_id",
    "subagent_name",
    "model_used",
    "input_hash",
    "output_summary",
    "parent_call_id",
  ]) {
    assert.match(migration045, new RegExp(column));
  }
  assert.match(migration045, /subagent_calls_by_request/);
  assert.match(migration045, /subagent_calls_by_subagent_started/);
  assert.match(migration045, /subagent_calls_append_only/);
  assert.match(migration045, /revoke all on public\.subagent_calls from anon, authenticated/);
});

await t("dispatch planner fans travel turns to the right sub-agents", () => {
  const plan = planSubagentsForTurn({
    classification: {
      bucket: "tool_path",
      confidence: 0.93,
      reasoning: "flight search",
      provider: "fallback",
      model: null,
      latencyMs: 0,
      source: "provider_unavailable",
    },
    userId: "11111111-1111-1111-1111-111111111111",
    lastUserMessage: "find me a flight from NYC to Vegas on May 5",
    installedAgentCount: 2,
    connectedAgentCount: 1,
    hasRegistryAgents: true,
  });
  assert.deepEqual(
    plan.agents.map((agent) => agent.name),
    ["memory-retrieval", "intent-deep", "marketplace-intel"],
  );
  assert.equal(plan.agents.every((agent) => agent.timeoutMs > 0), true);
});

await t("intent-deep extracts flight slots for the Vegas demo path", () => {
  const slots = extractIntentSlots("find me a flight from NYC to Vegas on May 5 for 2 passengers in business");
  assert.equal(slots.primaryIntent, "flight_search");
  assert.equal(slots.origin, "JFK");
  assert.equal(slots.destination, "LAS");
  assert.equal(slots.passengerCount, 2);
  assert.equal(slots.cabinClass, "business");
});

await t("supervisor runs sub-agents in parallel and summarizes fallback evidence", async () => {
  const ok = new SubAgent({
    name: "ok-agent",
    model: "fast",
    timeoutMs: 200,
    run: async () => ({ answer: "ready" }),
    summarize: (result) => result.answer,
  });
  const fallback = new SubAgent({
    name: "fallback-agent",
    model: "reflex",
    timeoutMs: 200,
    run: async () => {
      throw new Error("primary failed");
    },
    fallback: async () => ({ answer: "fallback ready" }),
    summarize: (result) => result.answer,
  });
  const supervisor = new SupervisorOrchestrator([ok, fallback]);
  const summary = await supervisor.run({
    requestId: "mesh-test-request",
    userId: "user-1",
    sessionId: "session-1",
    query: "plan a trip",
    registry: { agents: {}, bridge: { tools: [], routing: {} }, loaded_at: Date.now() },
    installedAgentIds: [],
    connectedAgentIds: [],
    dispatchPlan: {
      bucket: "tool_path",
      agents: [
        { name: "ok-agent", model: "fast", reason: "test", required: true },
        { name: "fallback-agent", model: "reflex", reason: "test", required: false },
      ],
    },
  });
  assert.equal(summary.results.length, 2);
  assert.equal(summary.results[0].status, "completed");
  assert.equal(summary.results[1].status, "fallback");
  assert.match(summary.contextSummary, /ok-agent: ready/);
  assert.match(summary.contextSummary, /fallback-agent: fallback ready/);
});

await t("Duffel search creates v2 offer requests and projects offers", async () => {
  const calls = [];
  const client = new DuffelClient({
    apiKey: "test_key_placeholder",
    environment: "test",
    baseUrl: "https://api.duffel.test",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        data: {
          id: "orq_123",
          offers: [
            {
              id: "off_123",
              total_amount: "101.20",
              total_currency: "USD",
              payment_requirements: { requires_instant_payment: false },
              slices: [
                {
                  origin: { iata_code: "JFK" },
                  destination: { iata_code: "LAS" },
                  duration: "PT5H30M",
                  segments: [
                    {
                      marketing_carrier: { name: "Test Air" },
                      marketing_carrier_flight_number: "42",
                      departing_at: "2026-05-05T10:00:00",
                      arriving_at: "2026-05-05T12:30:00",
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    },
  });
  const offers = await searchOffers(
    { origin: "JFK", destination: "LAS", departDate: "2026-05-05", passengers: 2 },
    client,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/air\/offer_requests\?return_offers=true/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.data.slices[0].origin, "JFK");
  assert.equal(body.data.passengers.length, 2);
  assert.equal(offers[0].id, "off_123");
  assert.equal(offers[0].holdable, true);
});

await t("Duffel hold uses hold orders and rejects instant-payment offers", async () => {
  const paths = [];
  const client = new DuffelClient({
    apiKey: "test_key_placeholder",
    environment: "test",
    baseUrl: "https://api.duffel.test",
    fetchImpl: async (url, init) => {
      paths.push({ url: String(url), init });
      if (String(url).includes("/air/offers/off_hold")) {
        return jsonResponse({
          data: {
            id: "off_hold",
            total_amount: "99.00",
            total_currency: "USD",
            payment_requirements: { requires_instant_payment: false },
          },
        });
      }
      return jsonResponse({
        data: {
          id: "ord_123",
          booking_reference: "ABC123",
          total_amount: "99.00",
          total_currency: "USD",
          payment_status: { payment_required_by: "2026-05-01T00:00:00Z" },
        },
      });
    },
  });
  const hold = await createHold("off_hold", [{ type: "adult" }], client);
  assert.equal(hold.orderId, "ord_123");
  const orderBody = JSON.parse(paths[1].init.body);
  assert.equal(orderBody.data.type, "hold");
});

await t("Duffel offer projection and manifest expose merchant-of-record flight capabilities", () => {
  const offer = projectOffer({
    id: "off_project",
    total_amount: "50.00",
    total_currency: "USD",
    payment_requirements: { requires_instant_payment: true },
    slices: [],
  });
  assert.equal(offer.holdable, false);
  assert.equal(DUFFEL_FLIGHT_AGENT_MANIFEST.agent_id, "lumo-flights");
  assert.equal(DUFFEL_FLIGHT_AGENT_MANIFEST.agent_class, "merchant_of_record");
  assert.deepEqual(DUFFEL_FLIGHT_AGENT_MANIFEST.capabilities, [
    "search_flights",
    "hold_flight",
    "book_flight",
    "cancel_flight",
  ]);
});

await t("orchestrator feature flag wires mesh without removing legacy path", () => {
  assert.match(orchestrator, /LUMO_USE_MESH/);
  assert.match(orchestrator, /SupervisorOrchestrator/);
  assert.match(orchestrator, /<mesh_context request_id=/);
  assert.match(orchestrator, /runTurnInner\(input, emit, timing\)/);
});

await t("Duffel flight tools are registered as internal merchant-of-record tools", () => {
  for (const tool of [
    "duffel_search_flights",
    "duffel_hold_flight",
    "duffel_book_flight",
    "duffel_cancel_flight",
  ]) {
    assert.match(integrationRegistry, new RegExp(tool));
  }
  assert.match(integrationRegistry, /buildDuffelFlightsEntry/);
  assert.match(integrationRegistry, /requires_confirmation: "structured-reservation"/);
  assert.match(integrationRegistry, /cost_tier: "money"/);
});

await t("Vegas flight demo path plans, extracts slots, and returns Duffel offers", async () => {
  const userMessage = "find me a flight from NYC to Vegas on May 5";
  const plan = planSubagentsForTurn({
    classification: {
      bucket: "tool_path",
      confidence: 0.95,
      reasoning: "travel search",
      provider: "fallback",
      model: null,
      latencyMs: 0,
      source: "provider_unavailable",
    },
    userId: "11111111-1111-1111-1111-111111111111",
    lastUserMessage: userMessage,
    installedAgentCount: 1,
    connectedAgentCount: 0,
    hasRegistryAgents: true,
  });
  assert.equal(plan.agents.some((agent) => agent.name === "intent-deep"), true);
  const slots = extractIntentSlots(userMessage);
  assert.equal(slots.origin, "JFK");
  assert.equal(slots.destination, "LAS");

  const client = new DuffelClient({
    apiKey: "test_key_placeholder",
    environment: "test",
    baseUrl: "https://api.duffel.test",
    fetchImpl: async () =>
      jsonResponse({
        data: {
          id: "orq_vegas",
          offers: [
            {
              id: "off_cheap",
              total_amount: "88.00",
              total_currency: "USD",
              payment_requirements: { requires_instant_payment: false },
              slices: [{ origin: { iata_code: "JFK" }, destination: { iata_code: "LAS" } }],
            },
            {
              id: "off_fast",
              total_amount: "120.00",
              total_currency: "USD",
              payment_requirements: { requires_instant_payment: true },
              slices: [{ origin: { iata_code: "JFK" }, destination: { iata_code: "LAS" } }],
            },
          ],
        },
      }),
  });
  const offers = await searchOffers(
    {
      origin: slots.origin,
      destination: slots.destination,
      departDate: "2026-05-05",
      passengers: slots.passengerCount,
    },
    client,
  );
  assert.equal(offers[0].id, "off_cheap");
  assert.equal(offers[0].summary, "JFK to LAS for USD 88.00");
});

if (fail) {
  console.error(`\n${fail} mesh-1 tests failed; ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} mesh-1 tests passed`);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
