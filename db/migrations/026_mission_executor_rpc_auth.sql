-- Migration 026 — mission executor RPC auth hardening.
--
-- Migration 024 correctly changed the executor claim RPC from pending
-- steps to ready steps, but the function also kept an in-body
-- `auth.role() = 'service_role'` predicate. In production that can fail
-- silent-empty even when the route is using a server-side client. The
-- durable authorization boundary is the function grant below: public,
-- anon, and authenticated cannot execute this RPC; only service_role can.
--
-- Rollback:
--   Re-run db/migrations/024_mission_confirmation_ready.sql.

create or replace function public.next_mission_step_for_execution(
  requested_limit integer default 10
)
returns table (
  id uuid,
  mission_id uuid,
  user_id uuid,
  step_order integer,
  agent_id text,
  tool_name text,
  reversibility text,
  inputs jsonb,
  confirmation_card_id text
)
language sql
security definer
set search_path = public
as $$
  with runnable as (
    select s.id
    from public.mission_steps s
    join public.missions m on m.id = s.mission_id
    where
      m.state in ('ready', 'executing')
      and s.status = 'ready'
      and not exists (
        select 1
        from public.mission_steps prior
        where
          prior.mission_id = s.mission_id
          and prior.step_order < s.step_order
          and prior.status not in ('succeeded', 'skipped')
      )
    order by m.updated_at asc, s.step_order asc
    for update of s skip locked
    limit greatest(1, least(coalesce(requested_limit, 10), 50))
  ),
  claimed as (
    update public.mission_steps s
    set
      status = 'running',
      started_at = coalesce(s.started_at, now()),
      updated_at = now()
    from runnable r
    where s.id = r.id
    returning
      s.id,
      s.mission_id,
      s.step_order,
      s.agent_id,
      s.tool_name,
      s.reversibility,
      s.inputs,
      s.confirmation_card_id
  ),
  touched_missions as (
    update public.missions m
    set
      state = 'executing',
      updated_at = now()
    from (select distinct mission_id from claimed) c
    where
      m.id = c.mission_id
      and m.state = 'ready'
    returning m.id
  )
  select
    c.id,
    c.mission_id,
    m.user_id,
    c.step_order,
    c.agent_id,
    c.tool_name,
    c.reversibility,
    c.inputs,
    c.confirmation_card_id
  from claimed c
  join public.missions m on m.id = c.mission_id
  order by m.updated_at asc, c.step_order asc;
$$;

revoke all on function public.next_mission_step_for_execution(integer) from public;
revoke all on function public.next_mission_step_for_execution(integer) from anon, authenticated;
grant execute on function public.next_mission_step_for_execution(integer) to service_role;

-- Cron-gated diagnostic helper. This is intentionally read-only and
-- service_role-only; it lets /api/cron/execute-mission-steps verify what
-- role PostgREST injected without opening the Supabase SQL editor.
create or replace function public.mission_executor_claim_diagnostics()
returns table (
  runtime_role text,
  ready_steps bigint,
  ready_missions bigint,
  claimable_ready_steps bigint
)
language sql
security definer
set search_path = public
as $$
  select
    coalesce(auth.role(), '') as runtime_role,
    (select count(*) from public.mission_steps where status = 'ready') as ready_steps,
    (select count(*) from public.missions where state = 'ready') as ready_missions,
    (
      select count(*)
      from public.mission_steps s
      join public.missions m on m.id = s.mission_id
      where
        m.state in ('ready', 'executing')
        and s.status = 'ready'
        and not exists (
          select 1
          from public.mission_steps prior
          where
            prior.mission_id = s.mission_id
            and prior.step_order < s.step_order
            and prior.status not in ('succeeded', 'skipped')
        )
    ) as claimable_ready_steps;
$$;

revoke all on function public.mission_executor_claim_diagnostics() from public;
revoke all on function public.mission_executor_claim_diagnostics() from anon, authenticated;
grant execute on function public.mission_executor_claim_diagnostics() to service_role;
