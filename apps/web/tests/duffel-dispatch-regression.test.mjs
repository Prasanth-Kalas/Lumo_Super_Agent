/**
 * DUFFEL-DISPATCH-REGRESSION-DIAG-1
 *
 * Locks the P0 failure mode where flight-search turns could degrade into
 * prose-only answers: tools disabled by fast-path routing, old selection
 * tool names, or Duffel results that were not shaped for the offers card.
 *
 * Run: node --experimental-strip-types tests/duffel-dispatch-regression.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyIntent,
  looksLikeFlightOfferRequest,
} from "../lib/perf/intent-classifier.ts";
import {
  flightOffersSelectionPayload,
  isFlightOfferDiscoveryTool,
} from "../lib/flight-offers-selection.ts";

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

console.log("\nduffel dispatch regression");

const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const systemPrompt = readFileSync("lib/system-prompt.ts", "utf8");

await t("flight-search request is never allowed to remain fast_path", async () => {
  const result = await classifyIntent(
    {
      messages: [{ role: "user", content: "look a flight to Vegas from Chicago next week" }],
      toolCount: 4,
      installedAgentCount: 1,
      connectedAgentCount: 1,
      hasPriorSummary: false,
      mode: "text",
    },
    {
      fetchImpl: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  bucket: "fast_path",
                  confidence: 0.96,
                  reasoning: "fixture deliberately misclassified",
                }),
              },
            },
          ],
        }),
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
  assert.equal(looksLikeFlightOfferRequest("look a flight to Vegas from Chicago next week"), true);
  assert.equal(result.bucket, "tool_path");
  assert.match(result.reasoning, /Duffel tool dispatch/);
});

await t("Duffel search is registered as the flight_offers selection source", () => {
  assert.equal(isFlightOfferDiscoveryTool("duffel_search_flights"), true);
  assert.match(orchestrator, /isFlightOfferDiscoveryTool\(toolName\)/);
  assert.match(orchestrator, /return "flight_offers"/);
  assert.match(orchestrator, /dispatchToolCall\(/);
  assert.match(orchestrator, /type: "selection"/);
});

await t("Duffel result array is normalized into FlightOffersSelectCard payload shape", () => {
  const payload = flightOffersSelectionPayload("duffel_search_flights", [
    {
      id: "off_test_123",
      totalAmount: "188.40",
      totalCurrency: "USD",
      expiresAt: "2026-05-02T12:00:00Z",
      slices: [
        {
          origin: "ORD",
          destination: "LAS",
          duration: "PT4H",
          segments: [
            {
              carrier: "United",
              flightNumber: "777",
              departingAt: "2026-05-08T13:00:00Z",
              arrivingAt: "2026-05-08T17:00:00Z",
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(payload, {
    offers: [
      {
        offer_id: "off_test_123",
        total_amount: "188.40",
        total_currency: "USD",
        owner: { name: "United", iata_code: "UN" },
        slices: [
          {
            origin: { iata_code: "ORD" },
            destination: { iata_code: "LAS" },
            duration: "PT4H",
            segments: [
              {
                departing_at: "2026-05-08T13:00:00Z",
                arriving_at: "2026-05-08T17:00:00Z",
                marketing_carrier: { iata_code: "UN" },
                marketing_carrier_flight_number: "777",
                carrier_name: "United",
              },
            ],
          },
        ],
        expires_at: "2026-05-02T12:00:00Z",
      },
    ],
  });
});

await t("prompt names the real Duffel tool and forbids prose-only flight prices", () => {
  assert.match(systemPrompt, /duffel_search_flights/);
  assert.match(systemPrompt, /never invent carriers, prices, or schedules/i);
  assert.doesNotMatch(systemPrompt, /flight_search_offers/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
