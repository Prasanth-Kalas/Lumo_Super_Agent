-- APPROVAL-USER-LEVEL-PROPAGATION-1 — first-party app approvals persist per user.
--
-- First-party Lumo apps use Lumo-owned provider infrastructure, so consent is
-- user-level: approving Lumo Flights once should unlock it in future chat
-- sessions until explicit revocation. Session app approvals remain as the
-- per-turn evidence ledger and dispatch-ready cache.
--
-- Rollback:
--   revoke execute on function public.connect_first_party_session_app_approval(uuid, text, text, text[], text) from service_role;
--   -- Re-apply db/migrations/051_session_app_approval_connections.sql to restore
--   -- the pre-053 function body if rolling back code and schema together.
--   drop policy if exists user_app_approvals_select_own on public.user_app_approvals;
--   drop trigger if exists user_app_approvals_touch_updated_at on public.user_app_approvals;
--   drop index if exists public.user_app_approvals_active_by_user;
--   drop table if exists public.user_app_approvals;

create table if not exists public.user_app_approvals (
  user_id uuid not null references public.profiles(id) on delete cascade,
  agent_id text not null check (
    length(agent_id) between 1 and 160
    and agent_id !~ '[[:space:]]'
  ),
  approved_at timestamptz not null default now(),
  granted_scopes text[] not null default '{}'::text[],
  connection_provider text check (
    connection_provider is null or connection_provider in (
      'duffel',
      'booking',
      'opentable',
      'doordash'
    )
  ),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, agent_id)
);

comment on table public.user_app_approvals is
  'User-level approval ledger for first-party Lumo apps. A non-revoked row propagates into each new chat session without re-showing the marketplace approval card.';
comment on column public.user_app_approvals.revoked_at is
  'Set when the user revokes first-party consent. Revoked rows do not bootstrap session approvals.';

create index if not exists user_app_approvals_active_by_user
  on public.user_app_approvals (user_id, approved_at desc)
  where revoked_at is null;

drop trigger if exists user_app_approvals_touch_updated_at on public.user_app_approvals;
create trigger user_app_approvals_touch_updated_at
  before update on public.user_app_approvals
  for each row execute function public.touch_updated_at();

with first_party_session_approvals as (
  select
    user_id,
    agent_id,
    approved_at,
    granted_scopes,
    case
      when connection_provider in ('duffel', 'booking', 'opentable', 'doordash') then connection_provider
      when agent_id in ('flight', 'lumo-flights') then 'duffel'
      when agent_id in ('hotel', 'lumo-hotels') then 'booking'
      when agent_id in ('restaurant', 'lumo-restaurants') then 'opentable'
      when agent_id in ('food', 'lumo-food') then 'doordash'
      else null
    end as connection_provider,
    row_number() over (
      partition by user_id, agent_id
      order by approved_at desc, updated_at desc, session_id desc
    ) as row_rank
  from public.session_app_approvals
  where agent_id in (
    'flight',
    'hotel',
    'restaurant',
    'food',
    'lumo-flights',
    'lumo-hotels',
    'lumo-restaurants',
    'lumo-food'
  )
)
insert into public.user_app_approvals (
  user_id,
  agent_id,
  approved_at,
  granted_scopes,
  connection_provider,
  created_at,
  updated_at
)
select
  user_id,
  agent_id,
  approved_at,
  coalesce(granted_scopes, '{}'::text[]),
  connection_provider,
  now(),
  now()
from first_party_session_approvals
where row_rank = 1
  and connection_provider is not null
on conflict (user_id, agent_id) do update
  set approved_at = greatest(public.user_app_approvals.approved_at, excluded.approved_at),
      granted_scopes = excluded.granted_scopes,
      connection_provider = excluded.connection_provider,
      updated_at = now();

alter table public.user_app_approvals enable row level security;
revoke all on public.user_app_approvals from anon, authenticated;
grant all on public.user_app_approvals to service_role;
grant select on public.user_app_approvals to authenticated;

drop policy if exists user_app_approvals_select_own on public.user_app_approvals;
create policy user_app_approvals_select_own on public.user_app_approvals
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.connect_first_party_session_app_approval(
  p_user_id uuid,
  p_session_id text,
  p_agent_id text,
  p_granted_scopes text[],
  p_connection_provider text default 'lumo_first_party'
)
returns table (
  user_id uuid,
  session_id text,
  agent_id text,
  granted_scopes text[],
  approved_at timestamptz,
  connected_at timestamptz,
  connection_provider text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  active_connection_id text;
  connection_id text;
  connected_time timestamptz := now();
  normalized_agent_id text := btrim(p_agent_id);
  expected_provider text;
begin
  if p_user_id is null then
    raise exception 'APPROVAL_USER_REQUIRED' using errcode = 'P0001';
  end if;

  if p_session_id is null or btrim(p_session_id) = '' then
    raise exception 'APPROVAL_SESSION_REQUIRED' using errcode = 'P0001';
  end if;

  if p_agent_id is null or normalized_agent_id = '' then
    raise exception 'APPROVAL_AGENT_REQUIRED' using errcode = 'P0001';
  end if;

  expected_provider := case
    when normalized_agent_id in ('flight', 'lumo-flights') then 'duffel'
    when normalized_agent_id in ('hotel', 'lumo-hotels') then 'booking'
    when normalized_agent_id in ('restaurant', 'lumo-restaurants') then 'opentable'
    when normalized_agent_id in ('food', 'lumo-food') then 'doordash'
    else null
  end;

  if expected_provider is null then
    raise exception 'APPROVAL_AGENT_NOT_FIRST_PARTY' using errcode = 'P0001';
  end if;

  if p_connection_provider is null or p_connection_provider <> expected_provider then
    raise exception 'APPROVAL_PROVIDER_UNSUPPORTED' using errcode = 'P0001';
  end if;

  insert into public.user_app_approvals (
    user_id,
    agent_id,
    granted_scopes,
    approved_at,
    connection_provider,
    revoked_at,
    created_at,
    updated_at
  )
  values (
    p_user_id,
    normalized_agent_id,
    coalesce(p_granted_scopes, '{}'::text[]),
    connected_time,
    p_connection_provider,
    null,
    connected_time,
    connected_time
  )
  on conflict (user_id, agent_id) do update
    set granted_scopes = excluded.granted_scopes,
        connection_provider = excluded.connection_provider,
        revoked_at = null,
        updated_at = excluded.updated_at;

  select id
    into active_connection_id
    from public.agent_connections
   where user_id = p_user_id
     and agent_id = normalized_agent_id
     and status = 'active'
   order by connected_at desc
   limit 1;

  if active_connection_id is null then
    connection_id := 'conn_lumo_' || replace(gen_random_uuid()::text, '-', '');

    insert into public.agent_connections (
      id,
      user_id,
      agent_id,
      status,
      access_token_ciphertext,
      access_token_iv,
      access_token_tag,
      scopes,
      provider_account_id,
      connected_at,
      last_refreshed_at,
      last_used_at,
      revoked_at
    )
    values (
      connection_id,
      p_user_id,
      normalized_agent_id,
      'active',
      '\x'::bytea,
      '\x'::bytea,
      '\x'::bytea,
      to_jsonb(coalesce(p_granted_scopes, '{}'::text[])),
      p_connection_provider,
      connected_time,
      null,
      null,
      null
    );
  else
    update public.agent_connections
       set scopes = to_jsonb(coalesce(p_granted_scopes, '{}'::text[])),
           provider_account_id = coalesce(provider_account_id, p_connection_provider),
           connected_at = coalesce(connected_at, connected_time),
           updated_at = connected_time
     where id = active_connection_id;
  end if;

  insert into public.session_app_approvals (
    user_id,
    session_id,
    agent_id,
    granted_scopes,
    approved_at,
    connected_at,
    connection_provider,
    created_at,
    updated_at
  )
  values (
    p_user_id,
    btrim(p_session_id),
    normalized_agent_id,
    coalesce(p_granted_scopes, '{}'::text[]),
    connected_time,
    connected_time,
    p_connection_provider,
    connected_time,
    connected_time
  )
  on conflict (session_id, agent_id) do update
    set user_id = excluded.user_id,
        granted_scopes = excluded.granted_scopes,
        connected_at = coalesce(public.session_app_approvals.connected_at, excluded.connected_at),
        connection_provider = excluded.connection_provider,
        updated_at = excluded.updated_at;

  return query
    select
      a.user_id,
      a.session_id,
      a.agent_id,
      a.granted_scopes,
      a.approved_at,
      a.connected_at,
      a.connection_provider
    from public.session_app_approvals a
   where a.session_id = btrim(p_session_id)
     and a.agent_id = normalized_agent_id;
end;
$$;

revoke all on function public.connect_first_party_session_app_approval(uuid, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.connect_first_party_session_app_approval(uuid, text, text, text[], text) to service_role;
