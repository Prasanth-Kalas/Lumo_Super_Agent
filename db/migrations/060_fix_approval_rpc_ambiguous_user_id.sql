-- APPROVAL-CONNECTION-RPC-STRICT-1 — qualify first-party approval RPC columns.
--
-- Prior versions of connect_first_party_session_app_approval selected and
-- updated public.agent_connections with unqualified user_id/id references.
-- Because the function returns table columns named user_id/session_id/agent_id,
-- PL/pgSQL could resolve user_id ambiguously and abort the approval write while
-- application code still emitted a fake "Approved" response.
--
-- Rollback:
--   Re-apply db/migrations/053_user_app_approvals.sql to restore the previous
--   function body if rolling back code and schema together.

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

  select ac.id
    into active_connection_id
    from public.agent_connections as ac
   where ac.user_id = p_user_id
     and ac.agent_id = normalized_agent_id
     and ac.status = 'active'
   order by ac.connected_at desc
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
    update public.agent_connections as ac
       set scopes = to_jsonb(coalesce(p_granted_scopes, '{}'::text[])),
           provider_account_id = coalesce(ac.provider_account_id, p_connection_provider),
           connected_at = coalesce(ac.connected_at, connected_time),
           updated_at = connected_time
     where ac.id = active_connection_id;
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
      saa.user_id,
      saa.session_id,
      saa.agent_id,
      saa.granted_scopes,
      saa.approved_at,
      saa.connected_at,
      saa.connection_provider
    from public.session_app_approvals as saa
   where saa.session_id = btrim(p_session_id)
     and saa.agent_id = normalized_agent_id;
end;
$$;

revoke all on function public.connect_first_party_session_app_approval(uuid, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.connect_first_party_session_app_approval(uuid, text, text, text[], text) to service_role;
