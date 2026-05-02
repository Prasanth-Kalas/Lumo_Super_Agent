-- Migration 063 — per-agent (across all users) rate + cost ceilings.
--
-- Today `agent_runtime_overrides` enforces per-(user, agent) caps:
-- one user can hit calls/min, calls/day, money calls/day. That
-- protects Lumo from a single user driving an agent into the ground,
-- but it does NOT protect Lumo from a viral partner where 10,000
-- users each call DoorDash 50 times and the agent racks up hundreds
-- of dollars in LLM/connector cost while every individual user stays
-- politely under their cap.
--
-- This migration adds two cross-user ceilings per agent:
--
--   max_calls_per_agent_per_minute  — global throughput throttle
--                                     (sum of all users' calls in a
--                                     rolling 60s window).
--   daily_cost_ceiling_usd          — total agent_cost_log spend for
--                                     this agent today (UTC).
--   monthly_cost_ceiling_usd        — same, this calendar month (UTC).
--
-- All three are nullable. NULL means "no per-agent limit" — keeps
-- backward-compat with every existing row, and stays null on insert
-- unless an admin explicitly sets a value. Per-user limits already
-- in the table continue to apply unchanged.
--
-- Read path (in lib/runtime-policy.ts checkQuotas) runs the per-user
-- checks first, then if they pass, runs these per-agent checks. The
-- per-agent count uses agent_tool_usage filtered by agent_id alone;
-- the per-agent cost uses agent_cost_log SUM(cost_usd_total) by
-- agent + window. Both need their own indexes since the existing
-- ones are (user_id, agent_id, ...).

-- 1. Columns. Nullable; absence = no limit.
alter table agent_runtime_overrides
  add column if not exists max_calls_per_agent_per_minute integer;

alter table agent_runtime_overrides
  add column if not exists daily_cost_ceiling_usd numeric(10,2);

alter table agent_runtime_overrides
  add column if not exists monthly_cost_ceiling_usd numeric(10,2);

-- Sanity checks. Negative or zero limits make no sense — null is
-- how you express "no cap." Postgres accepts these inline on add
-- column too, but a separate constraint keeps the column
-- declarations terse.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'agent_runtime_overrides_per_agent_minute_positive'
  ) then
    alter table agent_runtime_overrides
      add constraint agent_runtime_overrides_per_agent_minute_positive
      check (max_calls_per_agent_per_minute is null or max_calls_per_agent_per_minute > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'agent_runtime_overrides_daily_cost_ceiling_positive'
  ) then
    alter table agent_runtime_overrides
      add constraint agent_runtime_overrides_daily_cost_ceiling_positive
      check (daily_cost_ceiling_usd is null or daily_cost_ceiling_usd > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'agent_runtime_overrides_monthly_cost_ceiling_positive'
  ) then
    alter table agent_runtime_overrides
      add constraint agent_runtime_overrides_monthly_cost_ceiling_positive
      check (monthly_cost_ceiling_usd is null or monthly_cost_ceiling_usd > 0);
  end if;
end$$;

-- 2. Per-agent counting indexes. Existing indexes on
--    agent_tool_usage are compound on (user_id, agent_id, ...),
--    which doesn't help when we need "all rows for agent X in the
--    last 60s regardless of user."
create index if not exists agent_tool_usage_agent_minute_idx
  on agent_tool_usage (agent_id, created_at desc);

-- 3. Per-agent cost summing index. agent_cost_log has indexes on
--    (user_id, ...) but we need "sum cost_usd_total for agent X
--    over [start, end)." Postgres can use a btree on (agent_id,
--    created_at) to range-scan + aggregate.
create index if not exists agent_cost_log_agent_window_idx
  on agent_cost_log (agent_id, created_at);

comment on column agent_runtime_overrides.max_calls_per_agent_per_minute is
  'Cross-user request rate cap: max tool invocations for this agent in a rolling 60s window across all users. NULL = no cap.';
comment on column agent_runtime_overrides.daily_cost_ceiling_usd is
  'Cross-user daily cost cap: max sum of agent_cost_log.cost_usd_total for this agent in the current UTC day. NULL = no cap.';
comment on column agent_runtime_overrides.monthly_cost_ceiling_usd is
  'Cross-user monthly cost cap: max sum of agent_cost_log.cost_usd_total for this agent in the current UTC month. NULL = no cap.';
