# Cron jobs

Three scheduled jobs run on every Lumo deployment. This page is the operator's reference for what they do and how to monitor them.

## The three crons

Defined in `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/proactive-scan",   "schedule": "*/15 * * * *" },
    { "path": "/api/cron/evaluate-intents", "schedule": "*/15 * * * *" },
    { "path": "/api/cron/detect-patterns",  "schedule": "0 3 * * *" }
  ]
}
```

### `proactive-scan` — every 15 minutes

Runs three platform-level rules across every active user:
- **`trip_stuck`** — trips stuck in pending states too long.
- **`trip_rolled_back`** — rolled-back compound bookings.
- **`token_expiring`** — OAuth refresh tokens about to die.

Writes to `notifications` (dedup'd). No autonomous actions.

Typical duration: 500 ms – 2 s depending on active user count.

### `evaluate-intents` — every 15 minutes

Walks every active `standing_intents` row, checks if it's due (per its cron + tz), and if so evaluates the trigger. On trigger, either writes a notification or dispatches an autonomous action (subject to autonomy gate).

Typical duration: scales with intent count. 5 s for a hundred intents; 30 s for a thousand. If approaching the 30-second function timeout, move to background-job pattern.

### `detect-patterns` — daily at 03:00 UTC

Claude-backed analyzer over recent user activity. Upserts into `user_behavior_patterns` with fuzzy dedup.

Typical duration: 30 s – 5 min depending on active user count and Claude's latency.

## Authentication

Every cron endpoint verifies `Authorization: Bearer ${CRON_SECRET}`. Anything else → 401.

Vercel Cron includes this header automatically when `CRON_SECRET` is set in your env. No manual wiring.

If you're running crons from another scheduler (Heroku Scheduler, an external cron service, GitHub Actions), include the header in your POST request:

```
curl -X POST https://lumo.yourco.com/api/cron/proactive-scan \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Scheduling

**Vercel Pro** unlocks sub-daily crons (`*/15 * * * *` and shorter). **Vercel Hobby** limits to daily — you can still run Lumo, but standing intents can only trigger once a day and proactive scans will lag.

For non-Vercel hosts, use whatever your scheduler supports. The endpoints are plain HTTP.

## Monitoring

### Via `/ops`

The admin-gated dashboard at `/ops` reads from `ops_cron_runs` and shows:

- **Health cards** — one per cron, green/amber/red based on recent run success.
- **Run histogram** — last 20 runs by duration.
- **Error drilldown** — click to see the `errors` JSONB from failed runs.

Refresh the page for the latest data.

### Via Vercel

Vercel dashboard → your project → Cron Jobs shows:

- Next scheduled run time.
- Recent invocation history.
- Success/failure per run.

If Vercel says a run succeeded but `/ops` shows failed, the handler was reached but errored internally — check Vercel function logs.

### Via Supabase

```sql
select endpoint, started_at, finished_at, ok, counts, errors
from ops_cron_runs
where started_at > now() - interval '24 hours'
order by started_at desc;
```

Every cron run records itself, even if it errors early. If you see a `started_at` without a `finished_at`, the handler crashed before writing the completion (rare).

## What to do when a cron is red

**1. Check auth.** If `ok=false` and the error is `"401 Unauthorized"`, `CRON_SECRET` is misconfigured. Regenerate and set on both sides.

**2. Check Claude.** `evaluate-intents` and `detect-patterns` both call Anthropic. If `ANTHROPIC_API_KEY` is wrong or Anthropic is having an outage, those crons fail. Check [status.anthropic.com](https://status.anthropic.com).

**3. Check Supabase.** If `proactive-scan` is failing with DB errors, Supabase might be throttling you on the service role, or the DB is down.

**4. Check function timeouts.** If duration is approaching 30s, a cron may be timing out before it finishes. Solutions:
   - Reduce per-run work (e.g. paginate `evaluate-intents` by batching).
   - Move to a background-job host (Trigger.dev, Inngest).
   - Bump Vercel function timeout if your plan allows.

**5. Check the errors jsonb.** `ops_cron_runs.errors` is an array of `{ message, stack }` objects. Should point at the immediate culprit.

## What to do when a cron is amber (late)

"Amber" means the last run was older than 2× the expected interval. Causes:

- **Vercel Cron paused.** Check the Cron Jobs tab in Vercel — sometimes paused during deploys. Unpause.
- **Function cold-start failures repeatedly timing out**. Check logs for repeated short-duration runs ending in 504.
- **The cron expression is wrong**. Rare; if you didn't just change `vercel.json`, not this.

Amber for more than an hour = treat as red.

## Disabling crons temporarily

For maintenance windows or investigations:

- **Vercel**: toggle the cron to paused in the Cron Jobs tab.
- **Self-hosted**: comment out the cron entry in your scheduler.

Crons being off doesn't break the app — it just means proactive behaviors pause. User-driven chat still works.

## Running a cron manually

You can trigger any cron endpoint with an authenticated POST:

```bash
curl -X POST https://lumo.yourco.com/api/cron/proactive-scan \
  -H "Authorization: Bearer $CRON_SECRET"
```

Useful for:
- Testing a change immediately after deploy.
- Catching up after a brief outage.
- Investigating a specific user's state (the handler will log its decisions).

## Writing a new cron

Add a new file under `app/api/cron/<name>/route.ts`:

```ts
import { NextResponse } from "next/server";
import { recordCronRun } from "@/lib/ops";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const result = await recordCronRun("my-new-cron", async (addCount) => {
    // Do the work. Call addCount("rows_processed", n) as you go.
    return { ok: true };
  });
  return NextResponse.json(result);
}
```

Then add to `vercel.json`:

```json
{ "path": "/api/cron/my-new-cron", "schedule": "0 * * * *" }
```

Deploy. The cron will pick up on its next schedule tick.

## Related

- [observability.md](observability.md) — the `/ops` dashboard.
- [../architecture/proactive-engine.md](../architecture/proactive-engine.md) — what the crons are doing at a deeper level.
- [incident-runbook.md](incident-runbook.md) — cron failures in the broader incident flow.
