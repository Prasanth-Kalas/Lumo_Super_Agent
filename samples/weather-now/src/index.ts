import { readFileSync } from "node:fs";
import {
  defineSampleAgent,
  type SampleAgentResult,
} from "../../_shared/runtime.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../lumo-agent.json", import.meta.url), "utf8"),
);

interface WeatherNowOutputs {
  location: string;
  summary: string;
  temp_f: number;
  feels_like_f?: number;
}

export default defineSampleAgent({
  manifest,
  capabilities: {
    whats_the_weather_now: async (inputs, ctx): Promise<SampleAgentResult<WeatherNowOutputs>> => {
      const recall = await ctx.brain.lumo_recall_unified({
        query: "user's last-asked location for weather",
        limit: 1,
      });
      const location =
        recall.results[0]?.text ??
        stringInput(inputs.fallback_location) ??
        "current location";
      const connector = ctx.connectors["open-weather"];
      if (!connector?.current) {
        return failedWeather(location, "open-weather connector unavailable");
      }
      const weather = (await connector.current({ location })) as {
        summary: string;
        temp_f: number;
        feels_like_f?: number;
      };

      return {
        status: "succeeded",
        outputs: {
          location,
          summary: weather.summary,
          temp_f: weather.temp_f,
          feels_like_f: weather.feels_like_f,
        },
        provenance_evidence: {
          sources: [
            { type: "brain.recall", ref: "lumo_recall_unified", hash: recall.hash },
            { type: "connector.open-weather", ref: location },
          ],
          redaction_applied: false,
        },
        cost_actuals: { usd: 0.002, calls: 2 },
      };
    },
  },
});

function stringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function failedWeather(location: string, reason: string): SampleAgentResult<WeatherNowOutputs> {
  return {
    status: "failed",
    outputs: {
      location,
      summary: reason,
      temp_f: 0,
    },
    provenance_evidence: {
      sources: [{ type: "connector.open-weather", ref: "missing" }],
      redaction_applied: false,
    },
    cost_actuals: { usd: 0.001, calls: 1 },
  };
}
