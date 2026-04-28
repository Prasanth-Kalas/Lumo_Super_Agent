# Weather Now

`weather-now` is the smallest SAMPLE-AGENTS reference implementation. It is
intentionally boring: one read-only capability, one Brain recall call, one
connector call, one deterministic output.

## 60-second quickstart

```bash
node --experimental-strip-types samples/weather-now/tests/unit.test.mts
node --experimental-strip-types samples/weather-now/tests/e2e.test.mts
```

When SDK-1's CLI is present, the equivalent author flow is:

```bash
npx lumo-agent validate samples/weather-now/lumo-agent.json
npx lumo-agent dev samples/weather-now --sandbox
```

## Manifest walkthrough

- `trust_tier_target: experimental` — this sample proves the lowest-friction,
  read-only author path.
- `requires.brain_tools: ["lumo_recall_unified"]` — recall supplies a recent
  location hint so the capability does not need extra UI.
- `requires.connectors: ["open-weather"]` — the only external data source.
- `requires.scopes: ["read.recall", "read.location.current"]` — read-only,
  no confirmation card.
- `max_cost_usd_per_invocation: 0.005` — tests assert the sample stays under
  this ceiling.

## Capability

`whats_the_weather_now(inputs, ctx)`:

1. Calls `ctx.brain.lumo_recall_unified` for a location hint.
2. Falls back to `inputs.fallback_location` or `"current location"`.
3. Calls `ctx.connectors["open-weather"].current({ location })`.
4. Returns weather text, temperature, provenance, and local-dev cost actuals.
