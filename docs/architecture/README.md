# Architecture

The "how does it actually work under the hood" section. These pages are audience-agnostic — users dip in when they're curious about a specific behavior; developers read them to understand what their agents are plugging into; operators treat them as the reference for what the deployment is doing.

## Start here

- **[Overview](overview.md)** — The big-picture story. What the J1–J6 stack is, how a single user turn flows through it, and where the major components live in the repo.

## Capability-by-capability

- **[Data model](data-model.md)** — Every Postgres table Lumo uses, how it's scoped, and which migration introduced it.
- **[Orchestration](orchestration.md)** — The Claude-driven planner, the tool router, the agent registry, and how "pick the right tool" actually works.
- **[OAuth + tokens](oauth-and-tokens.md)** — PKCE, AES-256-GCM sealing, the callback handler, refresh-token flow.
- **[Memory system](memory-system.md)** — Profile, facts, embeddings, behavior patterns, the retrieval pipeline.
- **[Proactive engine](proactive-engine.md)** — Cron topology, standing intents, notification deduplication, rollback.
- **[Voice stack](voice-stack.md)** — SpeechRecognition, streaming TTS via ElevenLabs, barge-in, wake word, fallback cooldown.
- **[Observability](observability.md)** — `ops_cron_runs`, the `/ops` dashboard, how we decide what to surface.

## Design philosophy

A few principles that inform every component:

**Small, honest pieces.** Each lib module does one thing. `lib/connections.ts` is the DAO for `agent_connections` — nothing else. `lib/memory.ts` is the fact store — nothing else. This makes grep-based code review tractable.

**Graceful degradation.** If a provider is down, the relevant agent reports unhealthy and the orchestrator routes around it. If ElevenLabs fails, voice falls back to browser TTS. If Supabase auth isn't configured, the app runs signed-out everywhere. Nothing throws hard because an optional dependency is missing.

**Explicit consent surfaces.** Destructive or money-spending actions hit a confirmation card. OAuth flows show exact scope lists. Memory writes are either user-initiated or traceable to a `memory_save` tool call. No hidden side effects.

**Observability by default.** Every cron run records itself, every autonomous action logs to `/autonomy`, every error bubbles through a single `AgentError` type with a structured code. When something goes wrong, we can answer "what happened" without a debugger.

## How to read these pages

Each capability page follows the same template:

1. **What it does** — one paragraph user-visible summary.
2. **Where it lives in the code** — file paths.
3. **Data flow** — the sequence from input to output.
4. **Failure modes** — what breaks, and how we handle it.
5. **Extension points** — where to plug new behavior in.

If you're debugging, jump to section 4. If you're adding a feature, jump to section 5.
