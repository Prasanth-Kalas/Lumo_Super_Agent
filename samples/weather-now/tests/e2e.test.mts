import assert from "node:assert/strict";
import agent from "../src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../../_shared/runtime.ts";
import {
  assertCostWithinManifest,
  validateSampleManifestFile,
} from "../../_shared/validation.ts";

const validation = validateSampleManifestFile(
  new URL("../lumo-agent.json", import.meta.url).pathname,
);
assert.deepEqual(validation.errors, []);

for (const mode of ["dev", "sandbox"] as const) {
  const ctx = createSampleContext({
    request_id: `weather_${mode}`,
    connectors: {
      "open-weather": {
        current: async (input: unknown) => ({
          summary: `Clear in ${(input as { location: string }).location}`,
          temp_f: 72,
        }),
      },
    },
  });
  const result = await invokeSampleAgent(
    agent,
    "whats_the_weather_now",
    { fallback_location: "Las Vegas, NV" },
    ctx,
  );
  const outputs = result.outputs as { location: string };
  assert.equal(result.status, "succeeded");
  assert.equal(outputs.location, "San Francisco, CA");
  assertCostWithinManifest(validation, result.cost_actuals.usd);
}
