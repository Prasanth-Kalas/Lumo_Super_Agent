# Lumo Super Agent

The orchestrator. Chat-first, voice-next. Runs the Claude tool-use loop,
loads the agent registry from `config/agents.registry.json` on boot, and
dispatches each tool call to the matching specialist agent over HTTP.

## What this repo owns

| Subsystem | Where | Why it's here |
| --- | --- | --- |
| Chat UI | `app/page.tsx` + `components/` | Presentation — thread, input, itinerary confirmation card |
| `/api/chat` | `app/api/chat/route.ts` | SSE-stream orchestrator output to the client |
| Orchestrator | `lib/orchestrator.ts` | Claude tool-use loop, summary-envelope extraction |
| Router | `lib/router.ts` | Per-tool dispatch + money-gate (confirmation hash check) |
| Registry | `lib/agent-registry.ts` + `config/` | Discovers agents by URL, polls health |
| Circuit breaker | `lib/circuit-breaker.ts` | Per-agent failure isolation |
| System prompt | `lib/system-prompt.ts` | Single place the Claude brain's rules live |

## What this repo does NOT own

- Any agent implementation. Agents live in their own repos (`Lumo_Flight_Agent`,
  `Lumo_Food_Agent`, …) and are discovered over the wire.
- The SDK. Contract types + helpers live in `Lumo_Agent_SDK`, consumed as a
  pinned dependency. Editing SDK behavior from here is a smell — bump the SDK.

## Run locally

```bash
pnpm install
pnpm dev           # http://localhost:3000
```

For the orchestrator to find the flight agent, it has to be running on the
port `config/agents.registry.json` points at (default `3002`). In a second
terminal:

```bash
cd ../Lumo_Flight_Agent
pnpm dev           # http://localhost:3002
```

Then send a chat message like *"book me a flight from SFO to Vegas on May 1"*
— the orchestrator will search, price, render an itinerary confirmation card,
wait for you to confirm, and call the money tool with the hash gate enforced.

## The confirmation gate (critical invariant)

Money-moving tools (`flight_book_offer`, future `cart_checkout`, …) are
gated by a cryptographic hash of the rendered summary. The flow:

1. Claude calls `flight_price_offer` with an offer ID.
2. The Flight Agent attaches a `_lumo_summary` envelope to its response —
   `{ kind, payload, hash }`, where `hash = hashSummary(payload)`.
3. The shell extracts the envelope, stores it as `renderedSummary`, and
   strips it before passing the result to Claude (the model never sees
   internal metadata).
4. The shell emits an SSE `summary` frame; the client renders an
   `ItineraryConfirmationCard` below the assistant message.
5. User clicks Confirm or types "yes". The shell's next turn dispatches
   `flight_book_offer`.
6. Router's gate validates `ctx.user_confirmed && prior_summary.hash ===
   tool_call_summary_hash` (or omitted, in which case prior-summary presence
   alone is required). If either check fails, the tool call is refused with
   `confirmation_required` — never booked.

The SDK's `hashSummary()` is the one place this hash is computed, so the
agent and shell cannot drift.

## Dependency on `@lumo/agent-sdk`

Same story as every other Lumo repo: `file:../Lumo_Agent_SDK` during local
dev, swap to git URL or registry pin for CI/prod. See the SDK repo's README.

## Operational posture

- **Kill-switch per agent.** Flip `enabled: false` in the registry config,
  redeploy shell — that agent stops being offered to Claude within one cold
  start, regardless of its health.
- **Health degradation.** `agent-registry.ts` polls each agent's health URL.
  Score below 0.6 → the agent is silently dropped from the system prompt
  until it recovers.
- **Circuit breaker.** Consecutive failures trip the per-agent breaker;
  further calls return `upstream_error` without touching the agent, for N
  seconds.
