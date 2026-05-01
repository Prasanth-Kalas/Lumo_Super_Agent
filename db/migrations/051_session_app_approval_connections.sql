-- APP-INSTALL-CONNECTION-IDEMPOTENT-1 — first-party approval connection state.
--
-- Rollback:
--   revoke execute on function public.connect_first_party_session_app_approval(uuid, text, text, text[], text) from service_role;
--   drop function if exists public.connect_first_party_session_app_approval(uuid, text, text, text[], text);
--   drop index if exists public.session_app_approvals_connected_by_user_session;
--   alter table public.session_app_approvals drop column if exists connection_provider;
--   alter table public.session_app_approvals drop column if exists connected_at;

alter table public.session_app_approvals
  add column if not exists connected_at timestamptz,
  add column if not exists connection_provider text;

alter table public.session_app_approvals
  drop constraint if exists session_app_approvals_connection_provider_check;

alter table public.session_app_approvals
  add constraint session_app_approvals_connection_provider_check check (
    connection_provider is null or connection_provider in (
      'duffel',
      'booking',
      'opentable',
      'doordash'
    )
  );

comment on column public.session_app_approvals.connected_at is
  'Set when the approved app is dispatchable for this session. First-party Lumo apps become connected immediately on approval.';
comment on column public.session_app_approvals.connection_provider is
  'Concrete first-party provider that made the session approval dispatchable, for example duffel, booking, opentable, or doordash.';

update public.session_app_approvals
   set connected_at = coalesce(connected_at, approved_at),
       connection_provider = case
         when connection_provider is null or connection_provider = 'lumo_first_party' then
           case
             when agent_id in ('flight', 'lumo-flights') then 'duffel'
             when agent_id in ('hotel', 'lumo-hotels') then 'booking'
             when agent_id in ('restaurant', 'lumo-restaurants') then 'opentable'
             when agent_id in ('food', 'lumo-food') then 'doordash'
             else null
           end
         else connection_provider
       end,
       updated_at = now()
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
   and (
     connected_at is null
     or connection_provider is null
     or connection_provider = 'lumo_first_party'
   );

create index if not exists session_app_approvals_connected_by_user_session
  on public.session_app_approvals (user_id, session_id, connected_at desc)
  where connected_at is not null;

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
