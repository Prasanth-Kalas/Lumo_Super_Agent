# What is Lumo?

Lumo is one chat box that coordinates all the apps you already use.

You type (or say) what you want — "book me a flight to Austin Friday afternoon under $400", "order dinner from that Thai place we liked last month", "block 2–3pm Thursday for a call with Alex" — and Lumo works out which specialist agent can do the job, handles the OAuth handshake with the underlying service, runs the action, and shows you a receipt. No app-switching, no re-entering preferences, no "wait, which tab had that?"

## Why it exists

The last decade of "productivity" has meant more apps, more tabs, more context-switching. Every tool is excellent at one thing and makes you translate your intent into its own grammar. Lumo flips that: you express intent once, and the platform does the translation.

We borrow the shape from a science-fiction idea — the "just tell the computer what you want" affordance — and implement it with small, honest components: an orchestrator, a set of specialist agents with explicit contracts, OAuth for the user's own accounts, and a memory layer that remembers the boring facts so you never have to re-state them.

## The three pieces you see

1. **The chat.** A single interface. No modes, no menus to memorize. Ambient context (your location, time of day, recent activity) gets folded in automatically so "somewhere warm" doesn't require you to also specify "near me".
2. **The marketplace.** A catalog of specialist agents you connect to your own accounts. Today: Google (Gmail / Calendar / Contacts), Microsoft 365 (Outlook / Calendar / Contacts), Spotify, plus first-party travel and food agents. Tomorrow: whatever you need.
3. **Memory.** A small, editable record of what Lumo knows about you — your preferred airline seat, that your partner is vegetarian, that Tuesday mornings are for gym. You can read it, edit it, or wipe it at any time.

## The three pieces you don't see (but should trust)

1. **Voice and proactivity are opt-in.** Lumo doesn't listen unless you turn on voice mode. Lumo doesn't nudge you unless you create a standing intent. Nothing happens proactively at the account level without your say-so.
2. **Your tokens stay sealed.** When you connect Google or Microsoft, the tokens are encrypted with AES-256-GCM before they touch the database. Your email, calendar, and contacts are never written to Lumo's own storage — they pass through in memory when you ask a question, and are gone when the turn ends.
3. **Autonomy is calibrated, not assumed.** Lumo defaults to asking before it spends money or sends messages. You can turn that up (silent mode, within a daily cap) or down (confirm every action) at `/autonomy`, and there's a kill-switch that pauses all autonomous action with one click.

## What Lumo is not

- **Not another chat app.** Lumo doesn't replace Slack or iMessage; it reads what's happening across them so you don't have to context-switch to act on it.
- **Not a no-code builder.** Lumo is built for the end user who wants outcomes, not a canvas for stitching API calls together. (Developers who want to add new capabilities build agents against the SDK — see [developers/](../developers/README.md).)
- **Not a data broker.** Lumo doesn't aggregate user data, doesn't sell it, and doesn't keep it longer than an individual query needs. Details in [privacy.md](privacy.md).

## The honest caveats

- **Some things require paid provider plans.** Spotify playback control needs Spotify Premium on the listener's account. ElevenLabs voice previews need an active ElevenLabs subscription on the hosting Lumo deployment. Lumo tells you when a provider is refusing a request.
- **Lumo is a research preview.** Expect sharp edges. The full list of known-flaky surfaces lives in [troubleshooting.md](troubleshooting.md).
- **You're in charge.** At any moment you can disconnect an app (`/connections`), wipe memory (`/memory` → "Forget everything"), revoke autonomy (`/autonomy` → kill-switch), or sign out (bottom of the sidebar). No dark-pattern friction.

If that sounds like the kind of assistant you wanted — read [getting-started.md](getting-started.md) next.
