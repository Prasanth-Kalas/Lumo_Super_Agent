# Privacy — the plain-English contract

Lumo only works if you trust it. This page is our end of that trust contract, written so a reasonable person can read it end-to-end in five minutes.

## What Lumo stores about you

Everything here is keyed to your user id in a Postgres database. You can see most of it at `/memory` and `/connections`.

**Identity.**
- Email, full name, first name, timezone, language.
- Supabase-issued auth tokens (hashed; you don't see these, they rotate).

**Memory.**
- Profile fields you set or Lumo has learned (preferred airline, seat, budget tier, etc.).
- Free-form facts ("prefers vegetarian restaurants"), each with an embedding vector for semantic search.
- Behavior patterns (derived from your activity — "usually travels Tuesdays").

**Connections.**
- One row per connected app with its OAuth tokens. **Tokens are encrypted at rest** (AES-256-GCM; the key lives in the deployment's environment, never in the database).
- The scopes you granted and when you connected.
- Last-used and revoked timestamps.

**Activity records.**
- Trips / bookings Lumo has helped with (the receipt, not the provider data).
- Events the orchestrator logs for debugging (tool calls, timings, outcomes — no message content).
- Notifications the bell has shown you.

**Standing intents and autonomy settings.**
- Your configured intents, their triggers, schedules, and history.
- Your current autonomy tier, spend cap, and kill-switch state.
- The action log of every autonomous action Lumo has taken (for your audit trail).

## What Lumo does NOT store

This is the part that matters.

**Your provider content is never written to Lumo's database.**
- No `emails` table.
- No `calendar_events` table.
- No `contacts` table.
- No copies of songs, playlists, or listening history (beyond a transient reference used to answer one query).

When you ask "did anyone email me about the Q4 thread?", Lumo:
1. Loads your Google OAuth token out of the DB, decrypts it in memory.
2. Calls Gmail's API with the token.
3. Sees the matching threads (in RAM, for the duration of the turn).
4. Writes a response to you based on that content.
5. Drops the plaintext the moment the turn ends.

Nothing from Gmail is persisted by Lumo. The record of "this query happened" exists in the events log, but the content of your inbox does not.

Same story for Microsoft Graph, Spotify, and any future provider.

**Voice audio is not recorded.**
- Transcripts (text) pass through the orchestrator and are logged the same way typed messages are.
- The MP3 audio from ElevenLabs plays once in your browser and is discarded.
- Wake-word detection (if your deployment has it enabled) runs locally in your browser — the audio never leaves your device until after the wake word has triggered and you've consented to an interaction.

**Behavioral data is not aggregated across users.**
- Your patterns are derived from your data only.
- Your facts can only be retrieved by queries inside your account.
- We do not train models on your data.

## Who sees what

**You** — everything. Your profile, facts, patterns, action log, notifications, connections. All editable, all deletable.

**Your operator** (the person running the Lumo deployment for you — your company's IT team, or yourself if you're self-hosting) — has access to the database and can see the shape of what's stored (table contents). They CAN see your profile fields, your list of connections and scopes, and your action log. They CANNOT see:
- Plaintext OAuth tokens (those are encrypted with a key they may or may not hold separately).
- Any provider content (email bodies, calendar event details) — because Lumo doesn't persist that.

If you're self-hosting, you are the operator; this is purely informational. If you're using a managed Lumo deployment run by someone else, be aware that they have operator access to infrastructure — the same posture as with any SaaS tool.

**Third parties** — none. Lumo doesn't share your data, sell your data, or ship it to analytics providers. The only outbound calls are to the providers you've connected (Google, Microsoft, Spotify) and to the model providers (Anthropic for Claude, OpenAI for embeddings, ElevenLabs for voice) — and those calls go over TLS to their respective APIs to serve your specific query, with no "telemetry" side channel.

## Your controls

- **`/memory` → Forget everything** — wipes all your facts, patterns, and non-identity profile fields.
- **`/connections` → Disconnect** — revokes a connection. Tokens are soft-deleted immediately (row marked `revoked`, never used again) and where the provider supports revocation, Lumo also calls the provider's revoke endpoint.
- **`/autonomy` → Kill-switch** — pauses all autonomous action. Useful as a quick "I need Lumo to stop doing things" button.
- **`/intents` → Delete** — removes a standing intent and its history.
- **Sign out** — ends the current session. Tokens in the DB are not affected; re-signing in puts you back where you were.
- **Full account deletion** — contact your operator (or, on the managed deployment, use the feedback form). This purges every row with your user id — memory, connections, activity, intents, notifications. Permanent, irreversible.

## Data retention

- **Active user data** — retained as long as your account exists.
- **Deleted data** — gone within minutes of the deletion request (no soft-delete, no 30-day grace period).
- **Backups** — on managed deployments, encrypted database backups are retained for 7 days for disaster recovery only. Deletions propagate to backups within the 7-day window.
- **Logs** — application logs that don't contain user data (generic error traces, performance metrics) are retained per the operator's logging policy.

## Compliance posture

- **GDPR / CCPA** — the controls above (access, export, deletion) satisfy the right to access, right to erasure, and right to data portability. The `/memory` and `/connections` pages are your access point; account deletion covers erasure; your action log is exportable as JSON.
- **SOC 2** — in progress for the managed deployment. Ask the operator for the current status.
- **HIPAA** — Lumo is not currently HIPAA-compliant. Don't connect accounts that contain PHI (protected health information).
- **Children** — Lumo is not intended for users under 16. No child-specific content, no collection of data about minors.

## Specific provider notes

**Google / Gmail / Calendar / Contacts.** Only the scopes listed at `/marketplace` are requested. `gmail.readonly` means Lumo can read but never send, delete, or modify mail. `calendar` includes write — Lumo can create and modify events you ask it to. Disconnect also stops Lumo from using any past fetched content (since nothing was stored).

**Microsoft 365 / Outlook / Calendar / Contacts.** Same shape as Google. `Mail.Read` is read-only; `Calendars.ReadWrite` is read-write. `offline_access` is required to keep sessions alive longer than an hour — it does not grant additional data access.

**Spotify.** Scopes include search, current playback, recently played, and playback control. Lumo never posts on your behalf, never modifies your saved library unless you specifically ask it to.

## If you suspect a leak or misuse

1. Sign out of the browser you're worried about.
2. Hit the kill-switch at `/autonomy`.
3. Go to `/connections` and disconnect every connection.
4. Change the password on any provider you think might have been affected.
5. Contact your operator (or Lumo support for the managed deployment).

Lumo treats a suspected token leak as a P1 incident; the operator has a runbook at [../operators/incident-runbook.md](../operators/incident-runbook.md).

## Questions

The authoritative source for privacy is this page plus the code that implements it (`lib/crypto.ts`, `lib/connections.ts`, `lib/memory.ts`, `app/api/*`). If anything here doesn't match behavior, the code is the ground truth — and that's a bug worth reporting.
