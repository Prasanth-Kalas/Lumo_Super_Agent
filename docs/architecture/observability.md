# Observability

How Lumo tells operators what it's doing.

## Principles

- **Boring telemetry beats clever telemetry.** We write plain counters and durations to Postgres and read them with normal SQL. No APM vendor, no tracing tangle.
- **Every cron is a citizen.** If a job runs, it records the fact. If a job is unhealthy, the dashboard shows it.
- **User-scoped data is user-visible.** The user's action log at `/autonomy` uses the same `autonomous_actions` table the ops dashboard surfaces — same source of truth, different filters.

## The `ops_cron_runs` table

Introduced in migration 008. One row per cron invocation:

```
id            uuid PK
endpoint      text        'proactive-scan' | 'evaluate-intents' | 'detect-patterns'
started_at    timestamptz when the handler began
finished_at   timestamptz when the handler ended (null if still running or crashed)
ok            boolean     did it reach the stable completion path?
counts        jsonb       per-run stats (e.g. { users_scanned: 42, triggered: 3 })
errors        jsonb       array of error objects if ok=false
```

`lib/ops.ts::recordCronRun(endpoint, fn)` wraps any cron body:

```ts
export async function recordCronRun<T>(
  endpoint: string,
  fn: (addCount: (k: string, n: number) => void) => Promise<T>,
): Promise<T> {
  const runId = await insertRun(endpoint);
  const counts: Record<string, number> = {};
  const addCount = (k: string, n: number) =>
    (counts[k] = (counts[k] ?? 0) + n);
  try {
    const result = await fn(addCount);
    await finishRun(runId, { ok: true, counts });
    return result;
  } catch (err) {
    await finishRun(runId, {
      ok: false,
      counts,
      errors: [{ message: String(err), stack: (err as Error)?.stack }],
    });
    throw err;
  }
}
```

Every `app/api/cron/*` handler wraps itself in this helper, so the table populates automatically.

## The `/ops` dashboard

Admin-gated page (`app/ops/page.tsx`). Access is controlled by `LUMO_ADMIN_EMAILS` — a comma-separated list of emails in env. Signed-in users whose email is in the list see the dashboard; everyone else gets a 403.

Sections:

**Cron health cards.** One per cron endpoint. Each shows:
- Current status (green if last run was within 2× the cron interval and `ok=true`; amber if late; red if failing).
- Last 20 runs as a sparkline — bar height = duration (ms), color = ok/fail.
- Error summary if any recent failure.

**Autonomy activity.** Aggregates from `autonomous_actions` over the last 7 days:
- Count of autonomous actions per day (bar chart).
- Top 10 tools by invocation count.
- Spend totals (today / this week / this month).

**Notification stats.** From `notifications`:
- Total sent per day.
- Breakdown by `kind`.
- Read rate (percentage marked read within 24 hours).

**Pattern stats.** From `user_behavior_patterns`:
- Patterns added in the last 24 hours.
- Most common pattern strings (fuzzy-grouped) — tells you what Lumo is noticing about your users at an aggregate level.

## The `/api/ops/summary` endpoint

Server-side feed for the dashboard. Same admin gate. Returns a JSON blob:

```json
{
  "cron_health": [
    { "endpoint": "proactive-scan", "last_run": "...", "ok": true, "p95_duration_ms": 420 },
    ...
  ],
  "autonomy_stats": {
    "actions_today": 18,
    "actions_week": 92,
    "spend_today_cents": 4520,
    "top_tools": [{ "tool": "flight_book", "count": 12 }, ...]
  },
  "notification_stats": { ... },
  "pattern_stats": { ... }
}
```

If you want a Grafana or custom dashboard, this JSON is the stable API surface. The ops page just renders it client-side.

## Application-level logs

Everything `console.log` / `console.warn` / `console.error` in the app flows to Vercel's log drain (or whatever your host uses). Log hygiene guidelines enforced in code review:

- **Errors** → `console.error(context, err)`. Include structured context (user_id, tool, agent_id) so logs are greppable.
- **Warnings** → `console.warn("[module] short description:", detail)`. Used for graceful-degrade paths (e.g. "ElevenLabs auth failed, falling back to browser TTS").
- **Info** → `console.info("[module] transition info")`. Used sparingly; not for per-request noise.
- **Never `console.log`.** Kept for ad-hoc debugging; linter flags it. Production code uses the leveled variants.

## What we explicitly do NOT log

- **Conversation content.** No user messages, no assistant responses, no tool arguments. The event table records tool names and outcomes, never payloads.
- **OAuth tokens** (encrypted or plain).
- **Provider content** (emails, events, tracks).

This is a deliberate choice aligned with the privacy posture in [users/privacy.md](../users/privacy.md). If you need deeper debugging, use a local dev environment with a test account; don't turn on content logging in production.

## Metrics worth watching

If you're setting up alerts against the ops data, the ones that have mattered in practice:

- **Cron latency p95 > 2× baseline** → usually means Supabase is struggling or a particular user's memory blob is too big. Indicates work for the ops team before it turns into a visible-to-users problem.
- **Cron `ok=false` rate > 5% over 24 hours** → something's systemically broken; dig into `errors` column.
- **Autonomous action failure rate > 10%** (from `autonomous_actions.outcome='failed'`) → either an agent is misbehaving or a provider is having issues. Cross-reference with agent health.
- **Notification write rate spike (> 10× baseline)** → a standing-intent trigger is misbehaving platform-wide, or a platform rule is firing too liberally.

## Related

- [data-model.md](data-model.md#ops_cron_runs-migration-008) — table schema.
- [proactive-engine.md](proactive-engine.md) — the crons being observed.
- [operators/incident-runbook.md](../operators/incident-runbook.md) — what to do when these signals go bad.
