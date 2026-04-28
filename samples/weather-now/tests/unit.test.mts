import assert from "node:assert/strict";
import agent from "../src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../../_shared/runtime.ts";

const ctx = createSampleContext({
  brain: {
    lumo_recall_unified: async () => ({
      hash: "recall_sf_weather",
      results: [{ text: "San Francisco, CA", score: 0.94 }],
    }),
  },
  connectors: {
    "open-weather": {
      current: async () => ({
        summary: "Cool and clear",
        temp_f: 58,
        feels_like_f: 56,
      }),
    },
  },
});

const result = await invokeSampleAgent(
  agent,
  "whats_the_weather_now",
  {},
  ctx,
);
const outputs = result.outputs as {
  location: string;
  summary: string;
  temp_f: number;
};

assert.equal(result.status, "succeeded");
assert.equal(outputs.location, "San Francisco, CA");
assert.equal(outputs.summary, "Cool and clear");
assert.equal(outputs.temp_f, 58);
assert.equal(result.provenance_evidence.sources.length, 2);
assert.equal(ctx.costLog[0]?.usd, 0.002);
