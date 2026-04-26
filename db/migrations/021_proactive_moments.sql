-- Migration 021 — Sprint 2 proactive moments substrate.
--
-- Three tables that Sprint 2's anomaly-detection + forecasting + proactive
-- moment surfacing layer writes to. Schema-only change; the tables stay
-- empty until Codex's anomaly/forecasting wrappers land and the
-- proactive-scan cron starts populating them.
--
-- time_series_metrics: per-user metric points over time (revenue, views,
-- engagement, etc.) ingested from connectors or computed by Lumo Core.
-- anomaly_findings: outliers detected against those time series.
-- proactive_moments: user-surface-able insights derived from anomaly
-- findings, forecasts, calendar context, or pattern recognition.
--
-- Rollback:
--   drop function if exists public.next_proactive_moment_for_user(uuid, integer);
--   drop table if exists public.proactive_moments;
--   drop table if exists public.anomaly_findings;
--   drop table if exists public.time_series_metrics;

create table if not exists public.time_series_metrics (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  metric_key      text not null,
  ts              timestamptz not null,
  value           double precision not null,
  dimensions      jsonb not null default '{}'::jsonb,
  source_agent_id text,
  created_at      timestamptz not null default now()
);

create index if not exists time_series_metrics_by_user_metric_ts
  on public.time_series_metrics (user_id, metric_key, ts desc);

create index if not exists time_series_metrics_by_user_recent
  on public.time_series_metrics (user_id, created_at desc);

alter table public.time_series_metrics enable row level security;
revoke all on public.time_series_metrics from anon, authenticated;
grant all on public.time_series_metrics to service_role;

create table if not exists public.anomaly_findings (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  metric_key         text not null,
  finding_type       text not null check (finding_type in ('spike', 'drop', 'level_shift', 'pattern_change')),
  detected_at        timestamptz not null default now(),
  anomaly_ts         timestamptz not null,
  expected_value     double precision,
  actual_value       double precision not null,
  z_score            double precision,
  confidence         double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status             text not null default 'new' check (status in ('new', 'acknowledged', 'dismissed', 'investigated')),
  model_version      text,
  evidence           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists anomaly_findings_by_user_status
  on public.anomaly_findings (user_id, status, detected_at desc);

create index if not exists anomaly_findings_by_user_metric
  on public.anomaly_findings (user_id, metric_key, detected_at desc);

drop trigger if exists anomaly_findings_touch_updated_at on public.anomaly_findings;
create trigger anomaly_findings_touch_updated_at
  before update on public.anomaly_findings
  for each row execute function public.touch_updated_at();

alter table public.anomaly_findings enable row level security;
revoke all on public.anomaly_findings from anon, authenticated;
grant all on public.anomaly_findings to service_role;

create table if not exists public.proactive_moments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  moment_type     text not null check (moment_type in (
                    'anomaly_alert', 'forecast_warning', 'pattern_observation',
                    'time_to_act', 'opportunity'
                  )),
  title           text not null,
  body            text not null,
  evidence        jsonb not null default '{}'::jsonb,
  urgency         text not null default 'medium' check (urgency in ('low', 'medium', 'high')),
  valid_from      timestamptz not null default now(),
  valid_until     timestamptz,
  status          text not null default 'pending' check (status in (
                    'pending', 'surfaced', 'acted_on', 'dismissed', 'expired'
                  )),
  surfaced_at     timestamptz,
  acted_on_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists proactive_moments_by_user_pending
  on public.proactive_moments (user_id, valid_from desc)
  where status = 'pending';

create index if not exists proactive_moments_by_user_recent
  on public.proactive_moments (user_id, created_at desc);

drop trigger if exists proactive_moments_touch_updated_at on public.proactive_moments;
create trigger proactive_moments_touch_updated_at
  before update on public.proactive_moments
  for each row execute function public.touch_updated_at();

alter table public.proactive_moments enable row level security;
revoke all on public.proactive_moments from anon, authenticated;
grant all on public.proactive_moments to service_role;

-- Service-role RPC: fetch the next batch of pending, still-valid proactive
-- moments for a user. The proactive-scan cron uses this to decide which
-- moments to surface; the workspace UI consumes the surfaced ones.
create or replace function public.next_proactive_moment_for_user(
  target_user uuid,
  requested_limit integer default 5
)
returns table (
  id uuid,
  moment_type text,
  title text,
  body text,
  evidence jsonb,
  urgency text,
  valid_from timestamptz,
  valid_until timestamptz,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    m.id,
    m.moment_type,
    m.title,
    m.body,
    m.evidence,
    m.urgency,
    m.valid_from,
    m.valid_until,
    m.created_at
  from public.proactive_moments m
  where
    m.user_id = target_user
    and m.status = 'pending'
    and (m.valid_until is null or m.valid_until > now())
  order by
    case m.urgency when 'high' then 0 when 'medium' then 1 else 2 end,
    m.valid_from desc
  limit greatest(1, least(coalesce(requested_limit, 5), 25));
$$;

revoke all on function public.next_proactive_moment_for_user(uuid, integer) from public;
grant execute on function public.next_proactive_moment_for_user(uuid, integer) to service_role;
