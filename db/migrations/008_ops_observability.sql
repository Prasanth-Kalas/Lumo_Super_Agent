-- Migration 008 — Observability.
--
-- A single table: ops_cron_runs. Every cron endpoint writes one row at
-- the end of each tick. The /ops dashboard reads this plus the
-- existing autonomous_actions + notifications tables to surface:
--
--   - Last-run-per-cron with lag from scheduled tick (red/amber/green)
--   - Autonomy deny histogram by reason (last 7d)
--   - Pattern-detector yield per night
--   - Notification delivery counts
--
-- No new per-user rows — everything aggregates over existing tables.
-- No PII in ops_cron_runs.counts/errors — rule-specific integer
-- summaries only; raw event payloads stay in public.events.
--
-- RLS: off. Service-role only; the /api/ops/summary endpoint gates on
-- the LUMO_ADMIN_EMAILS allowlist before reading.

create table if not exists public.ops_cron_runs (
  id              text primary key,
  endpoint        text not null check (char_length(endpoint) between 3 and 80),
  started_at      timestamptz not null,
  finished_at     timestamptz not null,
  latency_ms      integer not null check (latency_ms >= 0),
  ok              boolean not null,
  counts          jsonb not null default '{}'::jsonb,
  errors          jsonb not null default '[]'::jsonb
);

-- Hot path: "last N runs of endpoint X" for the dashboard cards.
create index if not exists ops_cron_runs_by_endpoint_recent
  on public.ops_cron_runs (endpoint, finished_at desc);

-- Failure hot path: "anything that failed in the last 24h" for the
-- alerting banner.
create index if not exists ops_cron_runs_failures_recent
  on public.ops_cron_runs (finished_at desc)
  where ok = false;
