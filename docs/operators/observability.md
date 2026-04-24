# Observability (operator's view)

How to see what Lumo is doing. Pairs with the internals in [../architecture/observability.md](../architecture/observability.md).

## `/ops` — the admin dashboard

The page at `/ops` on your deployment is the one-stop-shop for operational health.

### Access control

Gated by the `LUMO_ADMIN_EMAILS` env var. Signed-in users whose email is in the comma-separated list see the page. Everyone else gets a 403.

Setting:

```
LUMO_ADMIN_EMAILS=ops@yourco.com, oncall@yourco.com
```

Changing this requires a redeploy. There is no admin role at the database level — this is a simple email allow-list.

### What it shows

**Cron health cards.** One per endpoint (proactive-scan, evaluate-intents, detect-patterns). Status chip (green / amber / red) plus the last 20 runs as a sparkline.

**Autonomy activity.** Autonomous actions per day, top tools, total spend.

**Notification stats.** Writes per day, breakdown by kind, read-rate.

**Pattern stats.** Behavior patterns added, top strings, pruning rate.

No drill-down into specific users — that's by design. Ops sees aggregate health; support answers individual-user issues by looking up their user_id directly in Supabase.

## Logs

### What gets logged

- **HTTP request summaries.** Vercel logs every request with status, duration, and path.
- **Structured app messages.** `console.warn` / `console.error` / `console.info` calls from server code.
- **Cron run markers** (via `ops_cron_runs`, not logs, but the app also logs cron start/finish for redundancy).

### What does NOT get logged

- User chat content (typed messages, assistant responses).
- Tool call arguments (only tool NAMES and outcomes).
- OAuth tokens (even masked — they simply don't appear).
- Provider content (email bodies, calendar details, etc.).

This is enforced by convention in code review, not by a runtime filter. If you see any of the above in logs, that's a bug.

### Where logs go

- **Vercel**: retained per your plan (Pro = 7 days by default, extendable).
- **Forwarded (recommended)**: Lumo emits standard stdout/stderr. Forward to:
  - **Datadog** — via the Vercel integration.
  - **Logflare** — native Vercel integration.
  - **BetterStack / Papertrail / Axiom** — all work via log drains.
  - **Self-hosted** (Loki, Elastic) — via Vercel Webhooks or a sidecar.

### Useful log greps

- `\[crypto\]` → OAuth token sealing / opening errors.
- `\[router\]` → tool-dispatch errors.
- `\[voice\]` → TTS and voice mode issues.
- `\[auth\]` → Supabase auth failures.
- `\[tts\] ElevenLabs upstream error` → ElevenLabs refused or timed out.

## Metrics

Lumo doesn't ship Prometheus / OpenTelemetry out of the box, but here's what you can derive from `ops_cron_runs`:

### Cron success rate (last 24h)

```sql
select endpoint,
       count(*) filter (where ok) * 1.0 / count(*) as success_rate,
       count(*) as total_runs
from ops_cron_runs
where started_at > now() - interval '24 hours'
group by endpoint;
```

Expect > 0.98. Below 0.95 is worth investigating.

### Cron duration percentiles

```sql
select endpoint,
       percentile_cont(0.50) within group (order by extract(epoch from finished_at - started_at)) as p50_s,
       percentile_cont(0.95) within group (order by extract(epoch from finished_at - started_at)) as p95_s
from ops_cron_runs
where finished_at is not null
  and started_at > now() - interval '7 days'
group by endpoint;
```

Use as baseline for alerts ("p95 more than 2× this baseline for > 1 hour = alert").

### Autonomous action failure rate

```sql
select date_trunc('day', fired_at) as day,
       count(*) filter (where outcome = 'success') as ok,
       count(*) filter (where outcome != 'success') as failed
from autonomous_actions
where fired_at > now() - interval '7 days'
group by 1 order by 1 desc;
```

Sustained failures mean an agent or provider is broken. Check the `reasoning` column on failed rows for specifics.

## Alerts worth setting

Setting these via whatever log forwarder / APM you use:

1. **Cron success rate < 95% over 1 hour** → someone's broken.
2. **Cron latency p95 > 2× 7-day baseline for 1 hour** → a specific cron is struggling; likely Supabase or Claude latency.
3. **5xx rate on `/api/chat` > 5% over 10 minutes** → orchestrator is failing; check Anthropic + Supabase status.
4. **Unauthorized call rate on `/api/cron/*` > 10/min** → someone's probing your cron endpoints; usually benign (security scanners) but worth noting.
5. **`LUMO_ENCRYPTION_KEY` pattern in logs** → should never log; if it does, it's a security bug.

## User-facing SLA posture

Lumo's "down" is a less common state than "degraded". Common degradations:

- **Chat works, voice doesn't** (ElevenLabs down) — premium TTS fallback to browser.
- **Chat works, Google tools don't** (Google down or refresh broken) — chat apologizes gracefully.
- **Chat works, notifications slow** (cron delayed) — users notice only if they're expecting a scheduled notification.

These are all "degraded", not "down". User-visible outage means Claude is down, Supabase Auth is down, or the Vercel deployment itself is down. Those are rare.

## Communicating during an incident

If you're running a multi-user deployment, consider a status page:

- [statuspage.io](https://statuspage.io) — standard.
- [instatus.com](https://instatus.com) — cheaper alternative.
- Custom page on your own domain — if you're self-hosted and low-traffic, a static incidents.md file works.

Post short, factual updates. "We're seeing elevated errors on Gmail integration. Investigating." beats radio silence.

## Related

- [crons.md](crons.md) — monitoring the three crons specifically.
- [incident-runbook.md](incident-runbook.md) — what to do when alerts fire.
- [../architecture/observability.md](../architecture/observability.md) — internals.
