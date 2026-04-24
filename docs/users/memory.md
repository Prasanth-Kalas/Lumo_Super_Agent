# Memory — what Lumo remembers

A good assistant doesn't make you repeat yourself. If you tell Lumo once that you prefer window seats, Lumo should remember that the next time you book a flight — not because it guessed, but because it actually stored that fact and can show it to you.

This page explains what gets remembered, where it lives, and how you control it.

## The three kinds of memory

### 1. Profile

Static, structured facts about you — timezone, language, display name, preferred airline, preferred seat, budget tier, and similar fields that rarely change. These are what makes Lumo's greeting personalized ("Hey Alex! Good morning.") and what travel agents use as defaults.

**You can edit every field directly at `/memory`.** Unset fields are optional — Lumo uses sensible defaults when you haven't told it otherwise.

### 2. Facts

Free-form statements Lumo has either been told by you or has inferred from conversation. Things like "prefers vegetarian restaurants", "partner is allergic to shellfish", "usually books flights on Wednesday evenings". Each fact is stored with:

- The statement itself.
- A timestamp (when it was learned).
- An embedding vector (a numeric fingerprint of the meaning, used to match facts to queries).
- An importance score (how central it is to who you are — learned over repeated mentions).

Facts get retrieved by semantic similarity when they're relevant. Ask "find me a restaurant for tonight" and the fact "partner is vegetarian" surfaces; ask "book me a flight" and it doesn't.

You can view, edit, and delete individual facts at `/memory`.

### 3. Behavior patterns

Patterns Lumo has noticed across many conversations — "you usually travel for work on Tuesdays", "you tend to order dinner around 7pm on weeknights", "your flights almost always land at SFO". These aren't things you told Lumo; they emerged from watching.

Patterns update nightly (see [architecture/proactive-engine.md](../architecture/proactive-engine.md)) and show up in the "What Lumo has noticed" strip on the `/memory` page.

## The /memory page

Your control surface for everything above lives at `/memory`. Sections you'll see:

- **Profile** — editable fields (name, timezone, language, preferences).
- **Facts** — list of everything Lumo has stored, with edit and delete buttons on each.
- **Patterns** — read-only view of the patterns Lumo has noticed. Not individually editable; wipe everything if you disagree with a pattern and it'll re-learn over time.
- **Voice** — the TTS voice picker (see [voice-mode.md](voice-mode.md)).
- **Forget everything** — nuclear option at the bottom.

## How memory is used

Every time you send a message, the orchestrator:

1. Loads your profile fields (instant — these are always in scope).
2. Embeds your query and runs a cosine-similarity search against your fact embeddings, keeping the top ~5 most relevant facts scored by a mix of similarity, recency, and importance.
3. Includes the matching facts and patterns in the system prompt before Claude plans its response.

The effect is that Lumo answers like a colleague who's been paying attention. You don't need to restate things in every conversation.

## Editing memory

On `/memory`, every fact has an edit pencil and a delete trashcan. Edits:

- Rewriting a fact is a normal save — the embedding gets regenerated so retrieval stays accurate.
- Deleting a fact permanently removes the row (and its embedding).
- Adding a fact manually: the composer at the bottom of the Facts section accepts a plain English statement. Lumo stores it immediately.

You can also say "remember that I hate aisle seats" in chat — Lumo has a `memory_save` meta-tool it calls when you explicitly ask it to remember something.

## Forgetting everything

The **Forget everything** button at the bottom of `/memory` wipes:

- All facts (rows + embeddings).
- All behavior patterns.
- All fields of your profile except the identity minimum (email, timezone — we keep these so the app keeps working).

It does **not** wipe: your account itself, your OAuth connections, your standing intents. Those have their own deletion paths (`/connections` → Disconnect; `/intents` → Delete; sign-in page → Account deletion once we ship that page).

Once you click Forget everything, there's a confirmation modal — then it's done. Irreversible, no soft-delete, no hidden backup.

## Memory and privacy

- **Memory is yours, not Lumo's.** You can read, edit, and delete every fact.
- **No silent memory.** Lumo stores facts only when (a) you tell it to, or (b) a fact-extraction step during a turn decides something is worth remembering — and that step is visible in the events log if your deployment has telemetry on. No black-box inference.
- **Embeddings are keyed to your user.** Nobody else's memory can retrieve your facts.
- **Patterns don't leave your row.** Behavior patterns are derived from your activity only. Lumo doesn't aggregate patterns across users or sell them.

Full privacy contract: [privacy.md](privacy.md).

## Why this matters

The thing that separates a helpful assistant from a tireless-but-dumb chatbot is whether it learns. If you find yourself re-explaining the same preference three conversations in a row, that's a bug — either Lumo isn't storing the fact, or it's storing it but not retrieving it. Either way, open an issue or just tell Lumo "you keep forgetting X" and we'll chase it down.
