/**
 * SAMPLE-AGENTS CI driver.
 *
 * Run: node --experimental-strip-types tests/sample-agents-ci.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import weatherAgent from "../samples/weather-now/src/index.ts";
import emailAgent, {
  sampleUnreadMessages,
} from "../samples/summarize-emails-daily/src/index.ts";
import rentalsAgent, {
  fixtureRental,
} from "../samples/lumo-rentals-trip-planner/src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../samples/_shared/runtime.ts";
import {
  assertCostWithinManifest,
  validateSampleManifestFile,
} from "../samples/_shared/validation.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.stack ?? e.message}`);
  }
};

console.log("\nsample reference agents");

const samples = [
  {
    dir: "samples/weather-now",
    agent: weatherAgent,
    capability: "whats_the_weather_now",
    expectedTier: "experimental",
  },
  {
    dir: "samples/summarize-emails-daily",
    agent: emailAgent,
    capability: "summarize_unread_inbox",
    expectedTier: "verified",
  },
  {
    dir: "samples/lumo-rentals-trip-planner",
    agent: rentalsAgent,
    capability: "book_rental",
    expectedTier: "official",
  },
];

await t("all sample directories expose the required file map", () => {
  for (const sample of samples) {
    for (const rel of [
      "lumo-agent.json",
      "README.md",
      "package.json",
      "tsconfig.json",
      "src/index.ts",
      "tests/unit.test.mts",
      "tests/e2e.test.mts",
    ]) {
      assert.equal(existsSync(join(sample.dir, rel)), true, `${sample.dir}/${rel}`);
    }
  }
});

await t("all manifests parse with the current SDK and sample extension", () => {
  for (const sample of samples) {
    const validation = validateSampleManifestFile(join(sample.dir, "lumo-agent.json"));
    assert.deepEqual(validation.errors, [], sample.dir);
    assert.equal(validation.extension.trust_tier_target, sample.expectedTier);
  }
});

await t("weather-now runs deterministically in dev and sandbox modes", async () => {
  for (const mode of ["dev", "sandbox"]) {
    const ctx = createSampleContext({
      request_id: `weather_ci_${mode}`,
      connectors: {
        "open-weather": {
          current: async () => ({ summary: "Sunny", temp_f: 74 }),
        },
      },
    });
    const result = await invokeSampleAgent(
      weatherAgent,
      "whats_the_weather_now",
      {},
      ctx,
    );
    assert.equal(result.status, "succeeded");
    assert.equal((result.outputs ?? {}).temp_f, 74);
    assertCostWithinManifest(
      validateSampleManifestFile("samples/weather-now/lumo-agent.json"),
      result.cost_actuals.usd,
    );
  }
});

await t("summarize-emails-daily runs and idempotently caches", async () => {
  const ctx = createSampleContext({
    connectors: {
      gmail: {
        listUnread: async () => ({ messages: sampleUnreadMessages() }),
      },
    },
  });
  const first = await invokeSampleAgent(
    emailAgent,
    "summarize_unread_inbox",
    {},
    ctx,
  );
  const second = await invokeSampleAgent(
    emailAgent,
    "summarize_unread_inbox",
    {},
    ctx,
  );
  assert.equal(first.status, "succeeded");
  assert.equal((first.outputs ?? {}).total_unread, 3);
  assert.equal((second.outputs ?? {}).cached, true);
  assertCostWithinManifest(
    validateSampleManifestFile("samples/summarize-emails-daily/lumo-agent.json"),
    first.cost_actuals.usd,
  );
});

await t("lumo-rentals-trip-planner returns a confirmation card before side effects", async () => {
  const result = await invokeSampleAgent(
    rentalsAgent,
    "book_rental",
    { rental: fixtureRental() },
    createSampleContext(),
  );
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.confirmation_card?.reversibility, "compensating");
  assert.equal(result.confirmation_card?.amount_cents, 24800);
  assert.match(result.confirmation_card?.side_effect_summary ?? "", /Stripe/);
});

await t("lumo-rentals-trip-planner confirms booking with provenance chain", async () => {
  const stripeFixture = JSON.parse(
    readFileSync(
      "samples/lumo-rentals-trip-planner/fixtures/stripe-charge.json",
      "utf8",
    ),
  );
  const calendarFixture = JSON.parse(
    readFileSync(
      "samples/lumo-rentals-trip-planner/fixtures/calendar-event.json",
      "utf8",
    ),
  );
  const ctx = createSampleContext({
    request_id: "rental_ci",
    connectors: {
      "lumo-rentals": {
        reserve: async () => ({ reservation_id: "res_sample_lumo_rental_001" }),
      },
      stripe: {
        charge: async () => stripeFixture,
      },
      "google-calendar": {
        createEvent: async () => calendarFixture,
      },
    },
  });
  const result = await invokeSampleAgent(
    rentalsAgent,
    "confirm_booking",
    { rental: fixtureRental(), request_id: "rental_ci" },
    ctx,
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.provenance_evidence.sources.map((source) => source.type),
    [
      "connector.stripe",
      "connector.lumo-rentals",
      "connector.google-calendar",
      "idempotency",
    ],
  );
  assertCostWithinManifest(
    validateSampleManifestFile("samples/lumo-rentals-trip-planner/lumo-agent.json"),
    result.cost_actuals.usd,
  );
});

await t("sample package quickstarts mention validate and sandbox flows", () => {
  for (const sample of samples) {
    const readme = readFileSync(join(sample.dir, "README.md"), "utf8");
    assert.match(readme, /60-second quickstart/i);
    assert.match(readme, /lumo-agent validate/);
    assert.match(readme, /--sandbox/);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
