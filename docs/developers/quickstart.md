# Quickstart — build your first Lumo agent in 15 minutes

We'll build a tiny "Weather" agent end-to-end — one tool that returns the forecast for a city. By the end you'll have it running in the Super Agent's registry and callable from chat.

This quickstart uses Next.js because that's the same framework the reference agents use and it gives you an HTTP server, OpenAPI hosting, and Vercel deployment for free. You can build a Lumo agent in any language — as long as it serves the right HTTP endpoints, Lumo doesn't care what's behind them.

## 1. Scaffold (2 min)

```bash
npx create-next-app@latest lumo-weather-agent --ts --app --no-tailwind --no-src
cd lumo-weather-agent
npm install @lumo/agent-sdk
```

If the package isn't public yet, install from git:

```bash
npm install github:Prasanth-Kalas/Lumo_Agent_SDK#v0.4
```

## 2. Write the manifest (3 min)

Create `app/api/manifest/route.ts`:

```ts
import type { AgentManifest } from "@lumo/agent-sdk";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const manifest: AgentManifest = {
    sdk_version: "0.4.0",
    agent_id: "weather",
    version: "0.1.0",
    display_name: "Weather",
    one_liner: "Current conditions and 7-day forecast for any city.",
    domain: "weather",
    intents: ["weather", "forecast", "is it raining"],
    example_utterances: [
      "What's the weather in Austin?",
      "Will it rain tomorrow in Seattle?",
      "Forecast for Tokyo this week",
    ],
    connect: { model: "none" },  // no auth — public weather data
    base_url: process.env.NEXT_PUBLIC_BASE_URL ?? "",
    openapi_url: "/api/openapi",
    listing: {
      category: "Utility",
      logo_url: "/logo.png",
      about_paragraphs: [
        "Lumo's weather companion. Current conditions, 7-day forecast, and severe-weather alerts for any city in the world.",
      ],
      privacy_note: "Weather data is fetched from a public API on demand; Lumo never stores your query history here.",
    },
  };
  return NextResponse.json(manifest);
}
```

Key fields explained in detail in [sdk-reference.md](sdk-reference.md); the minimum set is `agent_id`, `version`, `display_name`, `domain`, `intents`, `connect`, and `openapi_url`.

## 3. Write the OpenAPI (3 min)

Create `app/api/openapi/route.ts`:

```ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return NextResponse.json({
    openapi: "3.1.0",
    info: { title: "Weather Agent", version: "0.1.0" },
    paths: {
      "/api/tools/weather_now": {
        post: {
          operationId: "weather_now",
          summary: "Get current weather for a city",
          description:
            "Returns current temperature, conditions, and humidity for a named city.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["city"],
                  properties: {
                    city: { type: "string", description: "City name, optionally with state/country. Example: 'Austin, TX'" },
                    units: { type: "string", enum: ["metric", "imperial"], default: "metric" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Current weather snapshot",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      city: { type: "string" },
                      temperature: { type: "number" },
                      units: { type: "string" },
                      conditions: { type: "string" },
                      humidity_pct: { type: "number" },
                    },
                  },
                },
              },
            },
          },
          "x-lumo-autonomy": "read_only",
        },
      },
    },
  });
}
```

The `operationId` becomes the tool name Claude sees. `x-lumo-autonomy: "read_only"` tells the autonomy engine this tool has no side effects — it can always run automatically regardless of tier.

## 4. Implement the tool (4 min)

Create `app/api/tools/weather_now/route.ts`:

```ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface Body {
  city?: string;
  units?: "metric" | "imperial";
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Body must be JSON" } },
      { status: 400 },
    );
  }

  const city = body.city?.trim();
  const units = body.units ?? "metric";
  if (!city) {
    return NextResponse.json(
      { error: { code: "invalid_input", message: "city is required" } },
      { status: 400 },
    );
  }

  // Call your actual weather API here. Stubbed for the quickstart.
  return NextResponse.json({
    city,
    temperature: units === "metric" ? 22 : 72,
    units: units === "metric" ? "C" : "F",
    conditions: "Partly cloudy",
    humidity_pct: 64,
  });
}
```

## 5. Add a health endpoint (1 min)

The Lumo registry probes `GET /api/health` every few minutes to decide whether to include you in the tool catalog. Create `app/api/health/route.ts`:

```ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return NextResponse.json({
    ok: true,
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
}
```

## 6. Deploy to a reachable URL (1 min)

Local dev with `next dev` and `ngrok`:

```bash
# Terminal 1
npm run dev   # starts on http://localhost:3000

# Terminal 2
ngrok http 3000
# → https://something-random.ngrok-free.app
```

Or push to a Vercel preview — same effect, no tunnel required.

Set `NEXT_PUBLIC_BASE_URL` to whatever URL is actually reachable. The manifest's `base_url` determines where Lumo calls your tools.

## 7. Validate and submit (1 min)

Validate locally first:

```bash
npx lumo-agent validate ./agent-manifest.json
```

For a dev deployment, open `/marketplace` and submit through the publisher
flow. For a signed bundle submission, create a tarball and sign it:

```bash
tar -czf weather-agent.tar.gz app package.json
npx lumo-agent sign ./agent-manifest.json ./weather-agent.tar.gz
```

The managed publisher API stores the bundle, runs TRUST-1 automated checks, and
auto-publishes experimental agents when the checks pass. Higher trust tiers
enter the reviewer queue. See [publishing.md](publishing.md) for the full
submission path.

## 8. Try it

In the Super Agent's chat:

> What's the weather in Austin?

Claude picks your `weather_now` tool, calls `POST https://.../api/tools/weather_now` with `{ "city": "Austin", "units": "metric" }`, and Lumo shows the response. Done.

---

## What to read next

- **[sdk-reference.md](sdk-reference.md)** — full manifest and OpenAPI spec.
- **[oauth-integration.md](oauth-integration.md)** — if your agent needs an OAuth'd provider.
- **[authoring-guide.md](authoring-guide.md)** — how to write intents, utterances, and tools that feel good in product.
- **[testing-your-agent.md](testing-your-agent.md)** — simulate the router calling your tools without spinning up the full Super Agent.

## What can go wrong in the first 15 minutes

- **"My agent doesn't show up on /marketplace."** Registry probe failed. Check Super Agent logs. Most common: `base_url` points somewhere Lumo can't reach (localhost, firewalled IP), or `/api/health` returns non-200.
- **"Claude doesn't call my tool."** The `operationId`, `summary`, and `intents` work together — if none of them match the user's query semantically, Claude won't pick it. Add more example utterances and make sure the `summary` field describes what the tool does in clear language.
- **"My tool runs but the response doesn't make sense."** Double-check that your return shape matches the OpenAPI schema. Lumo validates responses against the schema and returns an error to Claude if they don't match.

For anything not covered here: [faq.md](faq.md).
