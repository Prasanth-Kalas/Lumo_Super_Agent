# Notifications

The bell icon at the top-right of the app is where everything Lumo wants to tell you outside an active conversation lands. This page explains what shows up there, how often, and how to tune it.

## What you'll see

The bell goes amber (unread badge) when there's a notification you haven't read. Click it to drop down the list. Each item has:

- A **short title** — what happened.
- A **body** — one or two sentences of context.
- A **timestamp** — when it was generated.
- An **action link** when applicable — "View trip", "Open conversation", "Approve booking".

Click an item to mark it read (or hit "Mark all read" at the bottom).

## Where notifications come from

There are two sources, and both are surgical — Lumo does not send "engagement" pings.

1. **Proactive scans** — every 15 minutes, the `/api/cron/proactive-scan` job runs three small checks:
   - **trip_stuck** — a booking that's been in "pending confirmation" state too long. You get a heads-up so you can re-try or cancel.
   - **trip_rolled_back** — a compound booking (flight + hotel) where one leg failed and the saga pattern automatically undid the successful legs. You get notified so the failure isn't silent.
   - **token_expiring** — an OAuth refresh token is about to expire. You get a reminder to reconnect before the next use fails.

2. **Standing intent triggers** — any intent you've set up that fires generates a notification. See [standing-intents.md](standing-intents.md).

That's the whole list. Nothing else writes to your bell.

## Frequency

Deduplicated by default. If the same trigger fires twice within the same cooldown window, you get one notification, not two. (Database-level: there's a partial unique index on `dedup_key` per user.)

If you find yourself getting more bell pings than feels right, the culprit is almost always a too-eager standing intent — edit its trigger to be more specific.

## Muting / pausing

- **Individual intents** — pause or delete the underlying intent at `/intents`.
- **Proactive scans globally** — flip the kill-switch at `/autonomy`. Proactive scans will still run (so you don't lose the check) but they won't write notifications while the kill-switch is on.
- **Everything** — sign out. Lumo doesn't run proactive checks for signed-out users.

There's currently no per-notification-type mute. If that would be useful, open an issue.

## When Lumo will NOT notify you

- No "we added a new feature" pings.
- No "your friend joined Lumo" pings.
- No marketing, ever.
- No notifications about things that don't need your attention. Silence is the default.

## Privacy note

Notifications are stored in the `notifications` Postgres table keyed to your user. They include only metadata Lumo already has (trip ids, intent ids, timestamps) — never provider content like email subjects or calendar event titles.

## Related

- **[Standing intents](standing-intents.md)** — the "I want to be notified about X" flow.
- **[Autonomy](autonomy.md)** — controls how Lumo acts on triggers, including the kill-switch.
- **[architecture/proactive-engine.md](../architecture/proactive-engine.md)** — the cron + notification deduplication internals.
