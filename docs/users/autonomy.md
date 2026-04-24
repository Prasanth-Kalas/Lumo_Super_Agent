# Autonomy — how independent Lumo is

Lumo can do real things — book flights, send emails, move money between buckets, buy dinner. The question is always: *how much should it ask first?*

The answer is yours. Lumo ships with a conservative default (ask before spending money, confirm before sending messages) and lets you turn it up or down at `/autonomy`.

## The three tiers

At `/autonomy` you'll see three named levels. Pick the one that matches how much trust you want to extend today. You can change this any time.

### Cautious (default)

Lumo acts automatically on **read-only** things (searches, lookups, summaries) and **reversible** things (saving a draft email, holding an airline booking but not paying). For anything that spends money, sends a message, or is hard to undo, Lumo shows a confirmation card and waits for you to approve.

Good if: you're new to Lumo, or the tasks at hand feel high-stakes.

### Balanced

Lumo acts automatically on anything **under your daily spend cap**. Above the cap, it confirms. It also still confirms for genuinely destructive actions (deleting things, posting publicly, sending mass emails) regardless of spend.

Good if: you trust Lumo on everyday tasks (dinner orders, small bookings) but want guardrails on bigger commitments.

### Proactive

Lumo acts automatically on anything within your daily cap and within its own safety rules. Confirmations still appear for truly irreversible or sensitive actions (buying a $2k flight, booking for other people, sending from a distribution list) but the bar is noticeably higher.

Good if: you're using Lumo as a real assistant and want speed over hand-holding.

## Spend cap

Under the tier picker is a daily spend cap slider. It defaults to $100/day and maxes at whatever your deployment allows. Every action Lumo takes that has a monetary side (the $40 DoorDash order, the $78 Lyft, the $420 hotel room) counts against this cap.

Once the cap is reached:
- Autonomous actions stop until the cap resets (midnight in your timezone).
- Lumo asks for confirmation on anything that would spend more.
- You can raise the cap any time at `/autonomy`.

The cap is **cumulative across all agents** — a $60 flight and a $50 dinner is $110 total, not two separate pockets. This is intentional: the whole point is a single ceiling on what Lumo can do in your name.

## The kill-switch

The big red button at the top of `/autonomy`. Click it and:

- All autonomous actions stop immediately.
- Proactive scans continue running (so they don't miss state changes) but cannot write notifications until you turn it back on.
- Standing intents keep their schedule but downgrade to "notify only" until the kill-switch is off.

The button has a "Paused until…" timestamp you can set — "pause for 1 hour", "pause until tomorrow", "pause indefinitely". When the timestamp expires, autonomy comes back automatically at whatever tier you had before.

Use the kill-switch when:
- You're going on vacation and don't want Lumo acting in your absence.
- Lumo did something you didn't expect and you want to review before letting it continue.
- You're debugging an integration and don't want cron jobs firing.

## Action log

Below the controls, `/autonomy` shows a reverse-chronological list of every autonomous action Lumo has taken on your behalf: which agent, which tool, what it cost, when it happened. Each row has a "See details" link that takes you to the conversation where it was triggered.

This is the audit trail. If Lumo ever does something that feels wrong, the log is where you look to understand what happened. You can also export the log as JSON for your records.

## What Lumo will never do, regardless of tier

These are hard safety limits — they don't bend to your autonomy tier.

- **Share your data without explicit approval.** Even if a specialist agent asks to include your email address in a booking, Lumo confirms first.
- **Execute financial trades, transfers, or payments to novel payees.** Budget management (categorization, reports) yes; actually moving money no — that always requires you to finalize.
- **Delete permanent records** (accounts, payment methods, saved credentials) without confirmation.
- **Send bulk messages to other people on your behalf.**
- **Modify security-sensitive settings** on your connected apps (2FA, active sessions, recovery codes).

Think of your autonomy tier as controlling the ceiling on reasonable operational autonomy. The hard limits above are separate — they're below any tier.

## How Lumo evaluates a proposed action

For every action a tool tries to execute, the autonomy engine runs this check (simplified):

1. Is the kill-switch on? → require confirmation.
2. Is this a hard-limit action? → require confirmation.
3. Does this spend money? → check against daily cap.
   - Over cap? → require confirmation.
   - Within cap? → check tier rules.
4. Is this reversible and side-effect-free? → auto-approve regardless of tier.
5. Otherwise → apply the tier's policy.

You can see the decision reasoning in the action log's details view ("approved because: within Balanced tier and $18 under daily cap").

## Recommended ramp

Most users settle in after about a week:

- **Day 1–3**: Cautious. Everything confirms. Get a feel for the shape of what Lumo proposes.
- **Day 4–10**: Balanced. Unwatch everything under $50. Review the action log at the end of each day for a few minutes.
- **Day 10+**: Decide based on how it's going. Plenty of people stay on Balanced forever; some move to Proactive for power use; a few stay on Cautious because they like the confirmation ritual.

There's no right answer. Tune to taste.

## Related

- **[Standing intents](standing-intents.md)** — how autonomy interacts with recurring jobs.
- **[Privacy](privacy.md)** — what's stored about actions Lumo takes.
- **[architecture/autonomy.md](../architecture/overview.md)** — the engine internals (see the J6 section).
