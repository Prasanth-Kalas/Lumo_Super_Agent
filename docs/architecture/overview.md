# Architecture overview

The Lumo Super Agent is a Next.js 14 App Router application backed by Supabase (Postgres + Auth), orchestrating calls to Anthropic Claude (reasoning), OpenAI (embeddings), ElevenLabs (voice), and a set of specialist agents (first-party + OAuth'd third-party). This page is the map you keep in your head for the rest of the architecture docs.

## The six capability pillars (the "J1–J6 stack")

Lumo was built in capability layers, each adding one behavior that a science-fiction assistant would need to feel present. Internally we name them J1 through J6 — they're not released separately, they're just a mental partition.

**J1 — Memory.** Structured profile + semantic facts + behavior patterns. Gives Lumo continuity across conversations. Key modules: `lib/memory.ts`, `lib/embeddings.ts`, migration `005_memory.sql`.

**J2 — Proactive engine.** Lumo watches for conditions you care about (a flight drop, a stuck booking, a token about to expire) and notifies when something changes. Cron-driven, three-rule baseline scanner. Modules: `lib/notifications.ts`, `app/api/cron/proactive-scan/route.ts`.

**J3 — Standing intents.** User-defined recurring jobs. "Check every morning", "notify me if X". Modules: `lib/standing-intents.ts`, `app/api/cron/evaluate-intents/route.ts`.

**J4 — Ambient context.** Every turn carries device-local time, timezone, rough location (if user granted it), and recent-pattern hints. Lets queries be natural ("somewhere warm" → your location + climate). Wired through the orchestrator's system prompt composer in `lib/system-prompt.ts`.

**J5 — Voice-first.** Always-on voice mode with barge-in detection and optional wake word. Modules: `components/VoiceMode.tsx`, `lib/barge-in.ts`, `lib/wake-word.ts`, `lib/streaming-audio.ts`, `app/api/tts/route.ts`.

**J6 — Autonomy calibration.** Tiered autonomy (Cautious / Balanced / Proactive) + spend caps + kill-switch + audit log. Modules: `lib/autonomy.ts`, migration `007_autonomy.sql`.

These stack cleanly: J1 memory feeds J4 ambient context, J2 proactive scans and J3 standing intents both respect J6 autonomy rules, J5 voice is just another I/O mode for the same orchestrator. You can disable any one (except J1; memory is load-bearing) and the rest still work.

## A single turn, end to end

What happens when you type "book me a flight to Austin Friday afternoon under $400" and hit send:

1. **Client** (`app/page.tsx`). The message goes into local state as a user turn. Ambient context is captured — `Date.now()`, `Intl.DateTimeFormat().resolvedOptions().timeZone`, cached geolocation if present. The composer POSTs to `/api/chat` with the full thread + ambient blob.

2. **Route handler** (`app/api/chat/route.ts`). Resolves the authenticated user via `getServerUser()`, then enters the orchestrator loop.

3. **Orchestrator** (`lib/orchestrator.ts`). Builds the system prompt by composing:
   - Base Lumo persona (from `lib/system-prompt.ts`).
   - User profile + top-K relevant facts + recent patterns (from `lib/memory.ts`).
   - Ambient context.
   - Tool catalog from the registry (only tools the user has healthy connections for).
   
   It then calls `anthropic.messages.create({ model: "claude-sonnet-4-6", tools, ... })` with the thread.

4. **Tool use**. Claude decides which tool to call (here, `flight_search`). The orchestrator dispatches through the router (`lib/router.ts`), which:
   - Looks up the agent manifest.
   - If `connect.model === "oauth2"`, fetches the sealed token from `agent_connections`, decrypts it, attaches it to the request.
   - Calls the agent's HTTP endpoint (or for internal agents, calls `dispatchInternalTool` directly).
   - Records tool-call telemetry via `lib/events.ts`.

5. **Response streaming**. Claude's response + tool-use blocks stream back to `/api/chat/route.ts`, which forwards them as SSE events to the client. The client (`app/page.tsx`) progressively renders text and any tool-result cards (e.g. `<FlightOffersSelectCard>`).

6. **Memory update**. If the turn included significant new info ("book me a flight — I always prefer aisle seats"), the orchestrator's `memory_save` meta-tool fires, writing a new fact + embedding to `user_facts`.

7. **Autonomy gate**. If the user has approved "Balanced" tier and the action is within the daily cap, the booking executes autonomously with a receipt. Otherwise the tool returns a `requires_confirmation` signal and the UI renders a confirmation card.

Same flow for voice: step 1 transcribes audio to text via browser `SpeechRecognition`, step 7 pipes the reply text to `/api/tts` for streaming MP3 playback. Otherwise identical.

## Directory map

```
Lumo_Super_Agent/
├── app/
│   ├── (pages)/            # marketplace, memory, connections, etc.
│   ├── api/
│   │   ├── chat/           # main orchestrator endpoint
│   │   ├── connections/    # OAuth start + callback + disconnect
│   │   ├── cron/           # proactive-scan, evaluate-intents, detect-patterns
│   │   ├── ops/            # /ops dashboard feed
│   │   └── ...             # memory, autonomy, notifications, intents, tts, etc.
│   └── page.tsx            # chat UI shell
├── components/             # React components (LeftRail, VoiceMode, AgentCard, ...)
├── lib/
│   ├── auth.ts             # Supabase SSR client + getServerUser
│   ├── connections.ts      # agent_connections DAO
│   ├── crypto.ts           # AES-256-GCM seal/open, PKCE helpers
│   ├── memory.ts           # profile + facts + patterns DAO
│   ├── embeddings.ts       # OpenAI text-embedding-3-small wrapper
│   ├── orchestrator.ts     # Claude tool-use loop
│   ├── router.ts           # tool → agent dispatch
│   ├── agent-registry.ts   # manifest loader + health probe
│   ├── autonomy.ts         # tier evaluation, spend cap, kill-switch
│   ├── notifications.ts    # bell store + dedup
│   ├── standing-intents.ts # DAO + cron-expression parser
│   ├── ops.ts              # cron-run telemetry
│   ├── integrations/       # per-provider adapters (google, microsoft, spotify, ...)
│   └── ...
├── db/migrations/          # SQL migrations 001–008
├── docs/                   # this directory
└── middleware.ts           # auth gate for protected routes
```

## The Lumo Agent SDK — a separate repo

The specialist agents Lumo orchestrates are independent services that implement the Lumo Agent SDK contract. The SDK itself lives at `../Lumo_Agent_SDK/` (adjacent to the Super Agent in your checkout) and is published as an npm package.

An agent is any HTTP service that:
- Exposes an OpenAPI document at a known URL.
- Exposes a manifest.json at a known URL with Lumo-specific metadata (display name, intents, `connect` block).
- Implements the handler shape the SDK's types define.
- Passes the registry's health probe.

Full treatment in [developers/sdk-reference.md](../developers/sdk-reference.md).

## External dependencies

| Service | What Lumo uses it for | Required? |
|---|---|---|
| Supabase (Postgres + Auth) | Primary data store, user authentication, session cookies. | Yes |
| Anthropic Claude | Orchestrator reasoning, tool-use planning, content generation. | Yes |
| OpenAI | Embeddings for memory retrieval (`text-embedding-3-small`). | Yes |
| ElevenLabs | Streaming TTS for voice mode. | Optional (falls back to browser `speechSynthesis`) |
| Vercel | Hosting + Cron. | Optional (any Node-compatible host works; Cron is only required for J2/J3) |
| Google Cloud | OAuth app for Gmail/Calendar/Contacts integration. | Optional (per provider) |
| Microsoft Entra ID | OAuth app for Microsoft 365 integration. | Optional (per provider) |
| Spotify Developer | OAuth app for Spotify integration. | Optional (per provider) |

Every "optional" dependency has a graceful-degradation path. If ElevenLabs isn't configured, the TTS route returns 503 and the voice layer falls back to browser TTS. If Google OAuth isn't configured, the Google card is hidden from `/marketplace`.

## Next

- If you want to understand the reasoning layer: [orchestration.md](orchestration.md).
- If you want the database schema: [data-model.md](data-model.md).
- If you want the token-handling story: [oauth-and-tokens.md](oauth-and-tokens.md).
- If you're building an agent: skip over to [developers/quickstart.md](../developers/quickstart.md).
