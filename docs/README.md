# Lumo Super Agent — Documentation

Lumo is a single chat interface that orchestrates specialist agents on your behalf. You talk; it routes the work to the right app, handles OAuth, remembers what matters, and shows you a clean summary when the work is done.

This directory is the source of truth for everything about Lumo — what it is for users, how it's built for engineers, and how to run it for operators.

---

## Who this is for

Lumo's documentation is split into three audiences. Pick the door that matches what you're trying to do.

### [→ For users](users/README.md)

You've signed up for Lumo and want to get real work done. These docs walk through connecting your apps (Google, Microsoft, Spotify), using voice mode, what Lumo remembers about you, setting up standing intents, and tuning how much autonomy Lumo has. Privacy posture is spelled out in plain English.

### [→ For developers](developers/README.md)

You're building a specialist agent that Lumo can orchestrate. These docs cover the Lumo Agent SDK — the manifest format, OpenAPI conventions, OAuth2 connect block, and `x-lumo-*` extensions. There's a 15-minute quickstart, a full SDK reference, and a tour of the four reference agents (Flight, Food, Hotel, Restaurant) that ship with the platform.

### [→ For operators](operators/README.md)

You run a Lumo deployment. These docs cover Vercel setup, every environment variable, Supabase migrations, cron jobs, the `/ops` observability dashboard, and what to do when things break. Per-provider OAuth app setup guides live under `operators/oauth-apps/`.

---

## Architecture deep-dive

The [`architecture/`](architecture/README.md) folder is audience-agnostic — it's the "how Lumo works under the hood" material that all three audiences dip into occasionally. Skim the [overview](architecture/overview.md) for the big picture; each capability (memory, OAuth, voice, the proactive engine, observability) has its own page.

---

## Quick navigation

| If you're trying to… | Start here |
|---|---|
| Understand what Lumo is | [users/what-is-lumo.md](users/what-is-lumo.md) |
| Connect your Gmail / Outlook / Spotify | [users/connecting-apps.md](users/connecting-apps.md) |
| Use voice mode | [users/voice-mode.md](users/voice-mode.md) |
| Build an agent in 15 minutes | [developers/quickstart.md](developers/quickstart.md) |
| Look up a manifest field | [developers/sdk-reference.md](developers/sdk-reference.md) |
| Register a new Google/Microsoft/Spotify app | [operators/oauth-apps/](operators/oauth-apps/) |
| See every `LUMO_*` env var | [operators/env-vars.md](operators/env-vars.md) |
| Understand how the orchestrator picks tools | [architecture/orchestration.md](architecture/orchestration.md) |
| Understand memory + embeddings | [architecture/memory-system.md](architecture/memory-system.md) |
| Recover from an incident | [operators/incident-runbook.md](operators/incident-runbook.md) |

---

## About these docs

- **First-draft manual.** Expect some rough edges. Open an issue or a PR against any page that's unclear, wrong, or out of date.
- **Versioned with the code.** Every doc sits alongside the code it describes. If a feature changes, the doc in the same commit should change too.
- **Markdown-first.** Plain Markdown everywhere so this content can be lifted into a docs site (Docusaurus, MkDocs, a Next.js route, a Webflow paste) without a rewrite.

If you're new: start with [users/what-is-lumo.md](users/what-is-lumo.md), then follow the links wherever your curiosity pulls you.
