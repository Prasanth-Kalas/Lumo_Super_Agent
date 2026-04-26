-- Migration 022 — Atomic proactive-scan dedupe.
--
-- Vercel cron retries and manual triggers can overlap. Migration 021 created
-- the substrate, but the cron still needed database-backed uniqueness so
-- duplicate findings/moments cannot be created by parallel runs.
--
-- Rollback:
--   drop index if exists public.proactive_moments_active_dedup_key;
--   drop index if exists public.anomaly_findings_unique_detection;

with duplicate_anomaly_findings as (
  select
    id,
    row_number() over (
      partition by user_id, metric_key, finding_type, anomaly_ts
      order by created_at asc, id asc
    ) as rn
  from public.anomaly_findings
)
delete from public.anomaly_findings a
using duplicate_anomaly_findings d
where a.id = d.id and d.rn > 1;

create unique index if not exists anomaly_findings_unique_detection
  on public.anomaly_findings (user_id, metric_key, finding_type, anomaly_ts);

with duplicate_active_moments as (
  select
    id,
    row_number() over (
      partition by user_id, moment_type, (evidence ->> 'dedup_key')
      order by
        case status when 'surfaced' then 0 when 'pending' then 1 else 2 end,
        created_at asc,
        id asc
    ) as rn
  from public.proactive_moments
  where
    status in ('pending', 'surfaced')
    and nullif(evidence ->> 'dedup_key', '') is not null
)
update public.proactive_moments p
set
  status = 'expired',
  updated_at = now(),
  evidence = p.evidence || jsonb_build_object('expired_reason', 'duplicate_dedup_key')
from duplicate_active_moments d
where p.id = d.id and d.rn > 1;

create unique index if not exists proactive_moments_active_dedup_key
  on public.proactive_moments (user_id, moment_type, ((evidence ->> 'dedup_key')))
  where
    status in ('pending', 'surfaced')
    and nullif(evidence ->> 'dedup_key', '') is not null;
