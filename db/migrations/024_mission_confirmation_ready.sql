-- Migration 024 — Sprint 3 confirmation-card mission linkage.
--
-- D3 introduces mission-step states that sit between "pending" and
-- "running": a side-effect step can be awaiting a confirmation card, then
-- become ready after the user approves that card. The executor RPC should only
-- claim ready steps.
--
-- Rollback:
--   create or replace function public.next_mission_step_for_execution(integer) ... from migration 023;
--   alter table public.mission_steps drop constraint if exists mission_steps_status_check;
--   alter table public.mission_steps add constraint mission_steps_status_check
--     check (status in ('pending','running','succeeded','failed','rolled_back','skipped'));

alter table public.mission_steps
  drop constraint if exists mission_steps_status_check;

alter table public.mission_steps
  add constraint mission_steps_status_check
  check (status in (
    'pending',
    'awaiting_confirmation',
    'ready',
    'running',
    'succeeded',
    'failed',
    'rolled_back',
    'skipped'
  ));

create index if not exists mission_steps_by_confirmation_card
  on public.mission_steps (confirmation_card_id)
  where confirmation_card_id is not null;

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
      auth.role() = 'service_role'
      and m.state in ('ready', 'executing')
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
grant execute on function public.next_mission_step_for_execution(integer) to service_role;
