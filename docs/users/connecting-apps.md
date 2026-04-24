# Connecting your apps

Lumo is most useful when it can act on your own accounts — reading your Gmail so it knows what "the quarterly review email" refers to, writing to your calendar so "block Thursday afternoon" actually blocks something. This page walks you through the connection flow, one provider at a time, and the "how to disconnect" story at the end.

## How the connection flow works

All connections follow the same shape:

1. You click **Connect** on a card in `/marketplace`.
2. Lumo mints a CSRF state and PKCE verifier, then builds the provider's OAuth URL with the exact scopes the card listed. Your browser is hard-redirected to the provider's login + consent screen.
3. You authenticate with the provider (not with Lumo — Lumo never sees your password) and approve the listed scopes.
4. The provider redirects back to Lumo with an authorization code. Lumo exchanges that code for access + refresh tokens, seals them with AES-256-GCM using the deployment's encryption key, and writes one row into the `agent_connections` table keyed to your user id.
5. You land on `/connections?connected=1` with a green banner. The provider card on `/marketplace` flips to a green **CONNECTED** badge.

From that point on, any time Lumo needs the underlying API (your Gmail, your calendar, etc.), it pulls the sealed token out of the database, decrypts it in memory, makes the call, and discards the plaintext when the turn ends. Refresh tokens are used transparently to stay connected.

## Google (Gmail · Calendar · Contacts)

**What Lumo asks for:**
- `gmail.readonly` — read your email (never send, never modify).
- `calendar` — read and write events on your primary calendar.
- `contacts.readonly` — look up contact info so "email Alex" works without you spelling out alex@example.com.
- `openid`, `email`, `profile` — so Lumo knows who you are inside Google and can show your name in the app.

**What you'll see at the provider:**
Google's account-chooser, then a consent screen that lists the scopes above in plain English. If you have multiple Google accounts signed in on the browser, pick the one you want Lumo to act on.

**What Lumo stores:**
Only the encrypted tokens and the scopes granted. Your email contents, calendar events, and contacts are fetched on demand and never written to Lumo's database.

Provider-level setup (for the operator who's standing up a Lumo deployment): [operators/oauth-apps/google.md](../operators/oauth-apps/google.md).

## Microsoft 365 (Outlook · Calendar · Contacts)

**What Lumo asks for:**
- `Mail.Read` — read your Outlook mail (never send, never modify).
- `Calendars.ReadWrite` — read and write events on your calendar.
- `Contacts.Read` — look up your contacts.
- `offline_access` — required to keep the session alive longer than an hour. Without this Lumo would have to re-prompt you every 60 minutes.
- `User.Read`, `openid`, `profile`, `email` — identity.

**What you'll see at the provider:**
Microsoft's "Pick an account" chooser followed by a Lumo consent screen. The screen will say "Lumo — unverified" until Lumo goes through Microsoft's publisher verification; that's expected for early-stage apps and doesn't affect the security of the flow.

**Works with both personal and work Microsoft accounts.** If your work tenant has strict consent policies, your IT admin may need to approve Lumo once for the whole org. Personal `@outlook.com` / `@hotmail.com` accounts need no extra steps.

Provider-level setup: [operators/oauth-apps/microsoft.md](../operators/oauth-apps/microsoft.md).

## Spotify

**What Lumo asks for:**
The standard read + playback-control scope set — current track, recently played, search, and (with Premium on the end user's account) play / pause / skip / queue.

**The Premium caveat.**
As of late 2024, Spotify requires **the Lumo deployment itself** to be on a Premium account to use the Web API at all, not just the end user. If you see a "Spotify temporarily unavailable" banner when you try to connect, it means the Lumo operator hasn't upgraded the hosting Spotify account yet — not a problem on your end.

Assuming the deployment is Premium-configured, Spotify's consent screen asks you to Agree; playback control then requires the listening user (you) to also be on Premium. Free accounts can still search and see recently played.

Provider-level setup: [operators/oauth-apps/spotify.md](../operators/oauth-apps/spotify.md).

## First-party agents (Flight / Food / Hotel / Restaurant)

These are always available — no OAuth, no setup. They're orchestrated internally by Lumo and don't access any of your personal accounts. Use them for:
- **Flight** — search and price flights.
- **Food** — find restaurants, build a cart, place delivery orders.
- **Hotel** — search and book hotel rooms in US cities.
- **Restaurant** — find restaurants and book reservations.

No connect button — they show on the marketplace as built-in.

## Managing connections

Everything you've connected lives at `/connections`.

For each active connection you'll see:
- **Display name + status chip** (green = active, amber = expired, red = revoked).
- **When you connected it** and when it was last used.
- **The scopes granted** — a comma-separated list of the provider's scope identifiers, so you can audit exactly what Lumo has access to.
- **A Disconnect button.**

Clicking Disconnect does two things: marks the row as `revoked` in Lumo's database so it stops being used immediately, and (for providers that support token revocation) calls the provider's revoke endpoint so the tokens themselves die. Disconnected connections stay visible under the "Previous connections" collapsible so you have a history — they can't be reused, they're just there for your records.

## What happens if a connection expires

Access tokens typically live for an hour; Lumo refreshes them silently in the background using the refresh token (that's what `offline_access` buys you on Microsoft, for example). If the provider invalidates the refresh token — because you changed your password, revoked Lumo from the provider's own app-permissions page, or the token genuinely expired — the next call returns `401 Unauthorized` and Lumo marks the connection as `expired` in the UI. You'll see a **Reconnect** CTA on the marketplace card; clicking it re-runs the OAuth flow.

## Privacy summary

This is worth restating because it's the thing that matters most:

- **Lumo never sees your provider password.** The consent screens are hosted by the provider, not Lumo.
- **Tokens are encrypted at rest.** AES-256-GCM, key lives in the deployment's environment (`LUMO_ENCRYPTION_KEY`) and never in the database.
- **Provider content is not persisted.** Your Gmail contents, calendar events, and contacts are fetched on the turn they're needed and dropped when the turn ends. There is no `emails` table, no `calendar_events` table.
- **Disconnect is honored immediately.** The moment you hit Disconnect, the row is revoked — the next request that tries to use it sees `revoked` and refuses.

If any of that is different on your deployment, it's a bug in the deployment's configuration, not in Lumo itself — see [privacy.md](privacy.md) for the full contract and [operators/env-vars.md](../operators/env-vars.md) for what your admin should have set.
