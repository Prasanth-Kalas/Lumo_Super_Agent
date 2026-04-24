# Standing intents

A standing intent is a recurring job Lumo runs on your behalf. Instead of remembering to ask "any fare drops on my flight?" every day, you tell Lumo once and it checks for you — quietly, on a schedule — and pings you only when there's something worth knowing.

## The mental model

A normal chat turn is synchronous: you ask, Lumo answers. A standing intent is asynchronous: you define the conditions under which you'd want to hear from Lumo, and Lumo watches for them.

Example intents people set up:

- *"Notify me if my Austin flight drops under $280."*
- *"Tell me if anyone replies to the Q4 thread between now and Friday."*
- *"Every Monday morning, summarize my calendar for the week."*
- *"If Spotify releases a new album from Phoebe Bridgers, add it to my playlist."*

## Creating an intent

Go to `/intents`. Hit **New intent**. You'll see a form with:

- **What to watch for** — a natural-language description of the trigger. Lumo compiles this into a check that runs on a schedule.
- **How often to check** — cron-style schedule (defaults: hourly, daily at 9am, weekly Monday 9am; custom is also allowed). For most intents, "every 15 minutes" is the finest grain available.
- **What to do when triggered** — either *"Notify me"* (default — you get a bell badge and can choose whether to act) or *"Act autonomously within my autonomy tier"* (Lumo does the thing without asking, subject to your [autonomy](autonomy.md) settings and spend caps).
- **Guardrails** — optional per-intent caps: maximum actions per day, maximum spend, total lifetime budget. These stack on top of your global autonomy caps — whichever is tighter wins.

## How intents run

Every 15 minutes (via Vercel Cron), the `/api/cron/evaluate-intents` job wakes up, loads every active standing intent across the platform, and checks which ones are due based on their cron expressions. For each due intent, it:

1. Runs the trigger check — usually a short Claude call that inspects the relevant world state (your inbox, a flight's fare, your calendar).
2. If the trigger fires, looks at your autonomy tier + the intent's action mode:
   - **Notify mode** → writes a `notifications` row, the bell turns amber, nothing else happens.
   - **Autonomous mode + within autonomy tier + within caps** → dispatches the action via the same router chat uses, writes a receipt notification.
   - **Autonomous mode + blocked by autonomy or caps** → falls back to notify mode for that trigger instance, so you don't miss it.

You always get a notification, whether Lumo acted or not. The bell at the top-right is the single surface for every passive update Lumo pushes you.

## Editing and pausing

At `/intents`, each intent shows its last-ran timestamp, its last-triggered timestamp (if any), and its current status. You can:

- **Edit** — change the trigger, schedule, action mode, or guardrails. Changes take effect at the next run.
- **Pause / Resume** — pause stops the intent from running but keeps its history. Useful for "I'm not traveling this month" or "I don't want intents firing during vacation".
- **Delete** — permanent, no soft-delete. The history goes too.

## Guardrails that Lumo enforces for you

Even if you set an intent to "act autonomously", Lumo won't:

- **Spend more than your daily cap** across all autonomous actions combined (set at `/autonomy`).
- **Touch the kill-switch state** — if you've paused all autonomy, intents downgrade to notify mode automatically.
- **Silently cross a consent boundary.** Actions that require explicit confirmation (booking a flight, sending a message on your behalf) still show the confirmation card — they just get pre-filled and waiting for your tap instead of requiring you to compose the request.

## Limits and good practices

- **Don't set intents cheaper than they need to be.** Every intent run costs a small amount of orchestrator time. Checking "any new emails about the Q4 thread?" every 15 minutes is fine; checking every minute is wasteful and noisy.
- **Trigger descriptions matter.** "Notify me about flight deals" is too vague and will fire on noise. "Notify me if LAX→AUS on 2026-05-03 drops below $280" is specific and reliable.
- **Use the "notify" mode first.** When you're setting up a new intent, keep it in notify mode for a few runs to see what it catches. Once you trust the trigger, flip it to autonomous if you want.
- **Keep a small number.** Most people work well with five to ten active intents. Above that it becomes noise. Lumo will show a gentle warning if you're piling up.

## Related

- **[Autonomy](autonomy.md)** — how Lumo decides whether an intent can act or only notify.
- **[Notifications](notifications.md)** — where intent triggers show up and how to manage them.
- **[architecture/proactive-engine.md](../architecture/proactive-engine.md)** — under-the-hood detail on the cron + the Claude-backed trigger evaluation.
