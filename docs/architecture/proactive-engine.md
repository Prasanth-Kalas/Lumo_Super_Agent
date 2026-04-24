# Proactive engine

The "Lumo does things without being asked" subsystem. Three crons, two tables, and one bell.

## Scope

There are two distinct proactive behaviors:

1. **Platform-level scans** — Lumo watches platform state (stuck bookings, rolled-back compound trips, expiring tokens) on every user's behalf automatically. The user doesn't opt in; these are baseline safety nets.
2. **User-defined standing intents** — Recurring jobs the user explicitly creates at `/intents`. See [users/standing-intents.md](../users/standing-intents.md) for the user-facing story.

Both share the same plumbing: a cron fires, the handler queries state, writes `notifications` rows, and optionally dispatches autonomous actions.

## Topology

```
vercel.json crons:
  */15 * * * *    /api/cron/proactive-scan      — platform scans
  */15 * * * *    /api/cron/evaluate-intents    — user standing intents
  0 3 * * *       /api/cron/detect-patterns     — behavior patterns (daily 03:00 UTC)
```

Cron frequency is Vercel Pro (sub-daily unlocked). On Hobby-tier deployments the schedules degrade to daily — some features degrade gracefully (intents can only check once a day) but the system stays functional.

Each cron handler:
1. Authenticates via the `CRON_SECRET` Bearer token (rejects anything else).
2. Records a `started_at` row in `ops_cron_runs`.
3. Executes its work.
4. Updates the row with `finished_at`, `ok`, `counts`, and any `errors`.

The ops dashboard at `/ops` reads this table to show health.

## Cron 1 — Proactive scan

Endpoint: `app/api/cron/proactive-scan/route.ts`. Every 15 minutes, runs three rules across every active user:

### Rule `trip_stuck`

Any `trips` row in `status IN ('dispatching', 'planning')` with `updated_at < now() - interval '30 minutes'` gets a notification:

```
Title: "Your trip isn't moving"
Body:  "Austin 5/3 has been queued for 38 minutes. Want to retry or cancel?"
```

Dedup key: `trip_stuck:{trip_id}`. One notification per stuck trip.

### Rule `trip_rolled_back`

Any `trips` row where `status='rolled_back'` and we haven't yet notified about it (no row with `dedup_key='trip_rolled_back:{trip_id}'` exists).

```
Title: "Trip undone"
Body:  "The hotel leg failed, so I unwound the flight. Nothing charged."
```

### Rule `token_expiring`

Any `agent_connections` row where `status='active'` and `expires_at < now() + interval '24 hours'` AND the connection has no refresh token (or we've seen previous refresh failures — tracked via an `errors` JSONB column not shown in the simplified data model).

```
Title: "Reconnect Google to keep it working"
Body:  "Your Gmail access expires tomorrow. One click to reconnect."
Action: /marketplace (filtered to the relevant agent)
```

Dedup key includes a time bucket so the same token doesn't spam — at most one "expiring" notification per 24-hour window.

### Telemetry

Every run writes to `ops_cron_runs` with counts like `{ users_scanned: 148, trip_stuck: 2, trip_rolled_back: 0, token_expiring: 5, total_notifications: 7 }`.

## Cron 2 — Evaluate standing intents

Endpoint: `app/api/cron/evaluate-intents/route.ts`. Every 15 minutes.

For each active `standing_intents` row:

1. Check if it's due based on its `cron` field and `tz`.
   - Lumo uses an in-house 5-field cron parser (`lib/standing-intents.ts::parseCron`) that respects the user's timezone for `hour` and `dow` interpretation. Implementation is minute-granular — the parser returns `true` if the current minute matches the expression in the user's tz.
2. If not due, skip. (Platform stays fast even with thousands of intents — no SQL cross-join pain.)
3. If due, run the trigger evaluation:
   - Build a targeted Claude prompt from `intent.description`, load relevant user context (profile facts, connected agents).
   - Have Claude inspect the current state: for "notify me if flight X drops below $280", the prompt includes the agent's `flight_price` tool and asks Claude to return `{ triggered: true|false, detail: "..." }`.
   - If not triggered, update `last_checked_at` and move on.
4. If triggered:
   - Consult `user_autonomy` for the user's tier and the intent's `guardrails`.
   - In `notify` mode or if autonomy blocks action: write a notification row, update `last_triggered_at`.
   - In `autonomous` mode AND autonomy approves: dispatch the action via the router, write a receipt notification and an `autonomous_actions` audit row.

### Guardrails precedence

The intent's own `guardrails` (`max_actions_per_day`, `max_spend_cents`) and the user's global `user_autonomy.daily_cap_cents` all apply. **Whichever is tighter wins.** If an intent has a $50 daily cap and the user has a $100 daily cap, autonomous actions stop at $50 for that intent alone; other intents/chats can still use the remaining $50.

### Telemetry

Counts: `{ intents_checked: 42, intents_due: 7, intents_triggered: 3, autonomous_dispatched: 1, notifications_written: 3 }`.

## Cron 3 — Detect behavior patterns

Endpoint: `app/api/cron/detect-patterns/route.ts`. Daily at 03:00 UTC.

For each user with activity in the last 30 days:

1. Pull activity summary (trip_events, chat turn counts, autonomous_actions) — **metadata only, not conversation content**. This keeps the cron's data view inside the same "no content persistence" posture as the rest of the app.
2. Call Claude with a structured prompt: "Given this activity shape, return up to 10 pattern descriptions the user might find useful."
3. For each returned pattern string, fuzzy-match against `user_behavior_patterns` rows:
   - >85% string similarity to an existing row → update `last_seen_at`, bump `evidence_count`.
   - ≤85% similarity → insert a new row with `evidence_count=1`.
4. Delete patterns with `last_seen_at < now() - interval '60 days'` — stale patterns don't get to live forever.

### Telemetry

Counts: `{ users_processed: 48, patterns_new: 12, patterns_updated: 87, patterns_pruned: 4 }`.

## Notifications — deduplication by partial unique index

```sql
create unique index notifications_user_dedup_idx
  on notifications (user_id, dedup_key)
  where dedup_key is not null;
```

Inserts use `ON CONFLICT (user_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`, so the same dedup_key inserted twice is a no-op. This is the single mechanism keeping the bell quiet under retry or double-firing conditions.

Patterns for dedup keys:
- Platform rules: `{rule}:{primary_id}` — e.g. `trip_stuck:abc123`.
- Intent triggers: `intent:{intent_id}:{bucket}` where bucket is a time window (day, hour, ...) appropriate to the intent's cadence.

## Kill-switch interaction

When `user_autonomy.kill_switch_until > now()`:
- Proactive scans **still run** (we don't want to miss a state change that matters).
- But they write NOTHING — neither notifications nor autonomous actions. The cron's `errors` JSONB records `{ kill_switch_skipped: true }` so ops can see it.
- The instant the kill-switch expires or is released, the next cron run catches up — any condition that was true during the pause window is still true and gets processed normally.

This is a deliberate design choice: the user asked for quiet, not for Lumo to forget. If they reopen after a week with "what happened?", the pattern + audit log + immediate next-scan notification tells the story.

## Failure modes

- **Cron doesn't run.** Vercel dashboard shows the schedule as "pending" or "error". `/ops` cron health card turns red within 30 minutes. Typical causes: `CRON_SECRET` mismatch (reject with 401 visible in Vercel logs), cold-start timeouts.
- **Scan partially completes.** `finished_at` gets written with `ok=false` and the specific error in `errors`. Next run retries from scratch — platform scans are idempotent by design.
- **Claude rate-limits or times out during intent eval.** Specific intent is marked with a per-intent last-error timestamp; it's not re-evaluated for 5 minutes (simple circuit breaker). Other intents proceed unaffected.
- **Notification dedup works but user still gets spammed.** Almost always means the intent's trigger description is too vague ("deals", "changes"). Fix is on the user side — tighten the trigger.

## Extension points

- **Adding a new platform rule.** Write a new function `async function ruleX(userId, ctx)` in `app/api/cron/proactive-scan/route.ts`, register it in the rule list. The run loop handles it automatically. Notifications for the rule should choose a stable `dedup_key` pattern.
- **Adding a new intent action mode.** Today's modes are `notify` and `autonomous`. A third like `draft` (prepare a message, don't send) would slot into `lib/standing-intents.ts::evaluateIntent` and introduce a new notification kind for the draft-ready state.
- **Different cron cadence.** `vercel.json` is source-of-truth. Change the schedule string and redeploy.

## Related

- [users/standing-intents.md](../users/standing-intents.md) — user-facing intent docs.
- [users/notifications.md](../users/notifications.md) — user-facing bell docs.
- [data-model.md](data-model.md) — tables: `notifications`, `standing_intents`, `ops_cron_runs`.
- [observability.md](observability.md) — how to read cron health at `/ops`.
