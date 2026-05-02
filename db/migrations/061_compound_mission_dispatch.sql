-- Migration 061 — compound mission dispatch wiring.
--
-- COMPOUND-MISSION-ROUTING-1 uses the existing durable missions ledger for
-- pre-booking search/planning dispatch. This migration adds explicit DAG
-- metadata to missions/mission_steps while preserving the legacy sequential
-- claim semantics for older rows.
--
-- Design defaults locked in docs/designs/orchestrator-compound-dispatch.md:
--   * assistant_compound_dispatch may use compound_transaction_id = mission:<id>
--     for pre-booking mission dispatches.
--   * /api/chat executes the first version inline, while the mission executor
--     remains able to recover queued explicit-DAG steps later.
--   * assistant_compound_step_update is additive progress evidence for live
--     mission:<id> dispatches; old clients ignore it.
--
-- Rollback:
--   alter table public.events drop constraint if exists events_frame_type_check;
--   alter table public.events add constraint events_frame_type_check check (
--     frame_type in (
--       'text','mission','tool','selection','summary','assistant_suggestions',
--       'assistant_compound_dispatch','leg_status','error','done','request','internal'
--     )
--   );
--   create or replace function public.next_mission_step_for_execution(integer)
--     ... from migration 026;
--   create or replace function public.mission_executor_claim_diagnostics()
--     ... from migration 026;
--   drop index if exists public.mission_steps_unique_client_step_id;
--   drop index if exists public.mission_steps_by_explicit_dependencies;
--   drop index if exists public.mission_steps_by_dispatch_tool;
--   drop index if exists public.missions_by_compound_dispatch;
--   alter table public.mission_steps drop column if exists output_summary;
--   alter table public.mission_steps drop column if exists dispatch_tool_name;
--   alter table public.mission_steps drop column if exists depends_on_step_orders;
--   alter table public.mission_steps drop column if exists dependency_mode;
--   alter table public.mission_steps drop column if exists client_step_id;
--   alter table public.missions drop column if exists compound_domains;
--   alter table public.missions drop column if exists compound_graph_hash;
--   alter table public.missions drop column if exists compound_dispatch_id;

alter table public.missions
  add column if not exists compound_dispatch_id text,
  add column if not exists compound_graph_hash text,
  add column if not exists compound_domains text[] not null default '{}'::text[];

comment on column public.missions.compound_dispatch_id is
  'Stable mission-dispatch identifier surfaced to chat UI as mission:<mission_id>.';
comment on column public.missions.compound_graph_hash is
  'SHA-256 hash of normalized compound mission DAG; used for deterministic replay diagnostics.';
comment on column public.missions.compound_domains is
  'First-party domains in this compound mission, e.g. flights/hotels/restaurants.';

alter table public.mission_steps
  add column if not exists client_step_id text,
  add column if not exists dependency_mode text not null default 'step_order',
  add column if not exists depends_on_step_orders integer[] not null default '{}'::integer[],
  add column if not exists dispatch_tool_name text,
  add column if not exists output_summary text;

alter table public.mission_steps
  drop constraint if exists mission_steps_dependency_mode_check;

alter table public.mission_steps
  add constraint mission_steps_dependency_mode_check
  check (dependency_mode in ('step_order', 'explicit'));

comment on column public.mission_steps.client_step_id is
  'Planner-stable step id within a compound mission, e.g. flight_search or hotel_search.';
comment on column public.mission_steps.dependency_mode is
  'step_order preserves legacy sequential missions; explicit uses depends_on_step_orders as a DAG.';
comment on column public.mission_steps.depends_on_step_orders is
  'For explicit-DAG missions, step_order values that must finish before this step can run.';
comment on column public.mission_steps.dispatch_tool_name is
  'Concrete tool invoked for mission.* steps, e.g. duffel_search_flights.';
comment on column public.mission_steps.output_summary is
  'Short user-safe summary of the tool output for progressive chat updates.';

create index if not exists missions_by_compound_dispatch
  on public.missions (compound_dispatch_id)
  where compound_dispatch_id is not null;

create index if not exists mission_steps_by_dispatch_tool
  on public.mission_steps (dispatch_tool_name, created_at desc)
  where dispatch_tool_name is not null;

create index if not exists mission_steps_by_explicit_dependencies
  on public.mission_steps (mission_id, dependency_mode, status, step_order asc)
  where dependency_mode = 'explicit';

create unique index if not exists mission_steps_unique_client_step_id
  on public.mission_steps (mission_id, client_step_id)
  where client_step_id is not null;

alter table public.events
  drop constraint if exists events_frame_type_check;

alter table public.events
  add constraint events_frame_type_check check (
    frame_type in (
      'text',
      'mission',
      'tool',
      'selection',
      'summary',
      'assistant_suggestions',
      'assistant_compound_dispatch',
      'assistant_compound_step_update',
      'leg_status',
      'error',
      'done',
      'request',
      'internal'
    )
  );

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
      and (
        (
          coalesce(s.dependency_mode, 'step_order') = 'step_order'
          and not exists (
            select 1
            from public.mission_steps prior
            where
              prior.mission_id = s.mission_id
              and prior.step_order < s.step_order
              and prior.status not in ('succeeded', 'skipped')
          )
        )
        or (
          s.dependency_mode = 'explicit'
          and not exists (
            select 1
            from public.mission_steps dep
            where
              dep.mission_id = s.mission_id
              and dep.step_order = any(s.depends_on_step_orders)
              and dep.status not in ('succeeded', 'skipped')
          )
        )
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
        and (
          (
            coalesce(s.dependency_mode, 'step_order') = 'step_order'
            and not exists (
              select 1
              from public.mission_steps prior
              where
                prior.mission_id = s.mission_id
                and prior.step_order < s.step_order
                and prior.status not in ('succeeded', 'skipped')
            )
          )
          or (
            s.dependency_mode = 'explicit'
            and not exists (
              select 1
              from public.mission_steps dep
              where
                dep.mission_id = s.mission_id
                and dep.step_order = any(s.depends_on_step_orders)
                and dep.status not in ('succeeded', 'skipped')
            )
          )
        )
    ) as claimable_ready_steps;
$$;

revoke all on function public.mission_executor_claim_diagnostics() from public;
revoke all on function public.mission_executor_claim_diagnostics() from anon, authenticated;
grant execute on function public.mission_executor_claim_diagnostics() to service_role;
