# Building agents for Lumo

This section is for engineers building specialist agents that Lumo can orchestrate. By the end you'll know the manifest format, the OAuth contract, how to publish an agent, and how to test it locally.

## In this section

- **[Quickstart](quickstart.md)** — Build and register your first agent in about 15 minutes.
- **[SDK reference](sdk-reference.md)** — The authoritative spec for `AgentManifest`, OpenAPI conventions, and `x-lumo-*` extensions.
- **[Authoring guide](authoring-guide.md)** — Design principles, intent naming, error shapes, UX conventions.
- **[OAuth integration](oauth-integration.md)** — How to wire an agent whose `connect_model` is `oauth2` (scopes, redirect URIs, PKCE).
- **[Lumo-ID integration](lumo-id-integration.md)** — First-party / internal-dispatch agents (no OAuth, baked into the registry).
- **[Testing your agent](testing-your-agent.md)** — Local dev setup, fixture patterns, registry health probes.
- **[App Store platform](appstore-platform.md)** — Deployment models, lifecycle states, certification gates, and runtime trust boundaries.
- **[Publishing](publishing.md)** — Getting your agent into a Lumo deployment's registry.
- **[Example agents](example-agents.md)** — Tour of the four reference agents that ship with Lumo.
- **[FAQ](faq.md)** — Common gotchas.

## The mental model

An agent is an **HTTP service** that exposes two URLs:

- A `manifest.json` — tells Lumo what you are, what you do, how to authorize, and where to find your schema.
- An `openapi.json` — tells Lumo the exact shape of every tool you expose.

Lumo's registry fetches both at startup (and on health probes), turns your tools into entries in Claude's tool catalog, and dispatches calls to your HTTP endpoints when users ask for what you do.

That's the whole thing. Everything below is about implementing that interface well.

## Before you start

You need:

- **Node 20+** (the SDK is published as an npm package; build tooling assumes modern Node).
- **A public URL** for your agent during development. `ngrok`, `cloudflared`, or a Vercel preview deployment all work. Localhost-only won't fly because the Super Agent's registry has to reach you.
- **An OAuth app** with a provider if your agent integrates one (Google, Stripe, whatever). You'll add the Super Agent's callback URL to its allowed redirects.
- **A Lumo deployment** (or local Super Agent dev server) to register your agent into.

## The hardest part is the manifest

You'll spend a surprising amount of time on the manifest. Naming intents well, picking the right scope list, writing example utterances that actually trigger your agent — those are product-design decisions, not plumbing. The [authoring guide](authoring-guide.md) covers the patterns that work.

The code itself is small. A typical agent's route handler is 50–200 lines.

## Why build on Lumo

You get:

- A chat-first UX without building one — user lives in Lumo, your agent gets typed and voiced traffic.
- User memory — Lumo knows the user's preferences and can pass them into your tools automatically (`preferred_seat`, `budget_tier`, etc.).
- OAuth plumbing — no need to build token storage, refresh flows, or disconnect UI.
- Autonomy gating — your "book this flight" tool can opt into the confirmation layer without reimplementing it.
- Observability — your tool calls, durations, and outcomes land in the event log automatically.

You keep:

- Your own data store.
- Your own infrastructure.
- Your own release cadence.
- Full control over what your tools actually do.

Lumo is a thin orchestration + consent + memory layer. Your agent is the thing that does the work.

## When NOT to build on Lumo

- You want full end-user-facing branding. Lumo is the user's frontend; your agent is backend.
- You need sub-100ms end-to-end latency on every tool call. There's a Claude round-trip in every user turn, so your tool needs to tolerate that.
- Your agent is a pure consumer app without API surface. Lumo agents are API-first.

Otherwise: welcome. Open [quickstart.md](quickstart.md) next.
