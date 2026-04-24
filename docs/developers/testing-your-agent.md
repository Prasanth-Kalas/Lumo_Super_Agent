# Testing your agent

Practical patterns for validating a Lumo agent before you push it at a real Super Agent.

## Three layers of testing

1. **Unit tests** — your tool handlers, isolated.
2. **Contract tests** — your HTTP endpoints against the SDK's expected shapes.
3. **End-to-end** — full round-trip through the Super Agent.

You want all three, but the first two catch most bugs early.

## 1. Unit tests

Just standard JS/TS testing. Your tool handler is a function that takes args + a token and returns a result:

```ts
// app/api/tools/flight_search/handler.ts
export async function flightSearch(args: FlightSearchArgs, token: string) {
  // ... call provider ...
  return { offers: [...] };
}
```

Test it with your usual framework:

```ts
// handler.test.ts
import { flightSearch } from "./handler";

describe("flightSearch", () => {
  it("returns offers for valid input", async () => {
    const result = await flightSearch(
      { origin: "SFO", destination: "LAX", depart_date: "2026-05-01" },
      "mock-token",
    );
    expect(result.offers).toHaveLength(3);
  });
  it("rejects missing destination", async () => {
    await expect(
      flightSearch({ origin: "SFO", depart_date: "2026-05-01" } as any, ""),
    ).rejects.toThrow("destination");
  });
});
```

Stub the provider HTTP calls with `msw`, `nock`, or your preferred HTTP mock.

## 2. Contract tests — OpenAPI conformance

The Super Agent validates your tool responses against the OpenAPI schema. Do the same in your test suite so you catch drift before it reaches production.

```ts
import { OpenAPISchemaValidator } from "openapi-schema-validator";
import openapi from "./openapi.json";

const validator = new OpenAPISchemaValidator({
  version: "3.1",
});
expect(validator.validate(openapi).errors).toEqual([]);

// Then validate specific responses:
import Ajv from "ajv";
const ajv = new Ajv({ strict: false });
const schema = openapi.paths["/api/tools/flight_search"].post.responses["200"]
  .content["application/json"].schema;
const validate = ajv.compile(schema);

it("response matches schema", async () => {
  const result = await flightSearch(...);
  expect(validate(result)).toBe(true);
});
```

## 3. End-to-end — against a real Super Agent

For a true round-trip:

1. **Run the Super Agent locally.** Clone `Lumo_Super_Agent`, install, run `npm run dev`.
2. **Run your agent locally.** `npm run dev` on your agent project.
3. **Expose your agent via tunnel.** `ngrok http 3000` or `cloudflared tunnel`.
4. **Register your agent.** Edit `lib/agent-registry.ts` in the Super Agent to include your ngrok URL.
5. **Sign in, connect (if OAuth), try a prompt.**

End-to-end tests catch integration mismatches no contract test will — you'll find out that your `summary` field isn't specific enough (Claude doesn't pick your tool), that your `intents` are too broad (Claude picks your tool for wrong queries), that your response shape is right but the values don't feel right in natural language.

## Mocking the Super Agent for router-only tests

If you want to simulate what happens when the router calls you — without running the whole Super Agent — the SDK exposes a helper:

```ts
import { simulateRouterCall } from "@lumo/agent-sdk/testing";

const result = await simulateRouterCall({
  manifest_url: "http://localhost:3000/api/manifest",
  tool: "flight_search",
  args: { origin: "SFO", destination: "LAX", depart_date: "2026-05-01" },
  user_id: "test-user",
  // For OAuth-modeled agents:
  access_token: "mock-provider-token",
});
```

This fetches your manifest, validates your OpenAPI, calls your tool endpoint with the same headers the router uses, and validates the response. Fails early on any contract violation.

## Fixture patterns

When your tool depends on provider state (the user's calendar, their email), keep a small set of fixture scenarios you can switch between:

```ts
// fixtures/calendar/empty.json
// fixtures/calendar/busy-week.json
// fixtures/calendar/conflict-with-existing-event.json
```

During local tests, set an env var like `LUMO_FIXTURE_CALENDAR=busy-week` and have your tool return the fixture when it's set. Keeps runs reproducible and makes E2E tests possible without real provider accounts.

## Health endpoint tests

At minimum:

```ts
it("health returns ok", async () => {
  const res = await fetch("http://localhost:3000/api/health");
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
});
```

If you report upstream status in your health response, test those paths too — especially the "upstream is down" path, so you're sure the health endpoint doesn't itself go down when the upstream does.

## Performance testing

For high-throughput agents, measure:

- **p50 / p95 / p99 tool call latency.** Under 500ms p95 is good for most tools; over 2s feels slow in chat.
- **Cold-start latency.** If you're on Vercel Edge or Lambda, first call after idle is slower. Warm-keep with a health-probe cron if it matters.
- **Max concurrent tool calls.** The Super Agent can dispatch 10 tools per user turn in parallel. If your agent's backing store can't, you'll queue.

## The smoke test you should always have

A single integration test that:

1. Starts your agent.
2. Fetches `/api/manifest` and validates it parses as `AgentManifest`.
3. Fetches `/api/openapi` and validates it parses as valid OpenAPI 3.1.
4. Calls `/api/health` and expects `{ ok: true }`.
5. For each tool in the OpenAPI, calls it with a canonical valid input and validates the response shape.

That's 10 minutes to write, catches the majority of dumb bugs, and lives in your CI. Do this.

## Local vs preview vs prod

Have three configurations:

- **Local** — ngrok-backed, against a local Super Agent.
- **Preview** — Vercel preview deploys, against a staging Super Agent deployment.
- **Prod** — only after preview has been green for a few days.

Different OAuth apps per tier (test creds for local/preview, real creds for prod). Never reuse prod tokens in local dev.

## Related

- [quickstart.md](quickstart.md) — build the first agent.
- [sdk-reference.md](sdk-reference.md) — contracts you're testing against.
- [publishing.md](publishing.md) — the last step after testing is green.
