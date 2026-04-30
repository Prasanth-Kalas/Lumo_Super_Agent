-- COMPOUND-IDEMPOTENCY-CONFLICT-1 RPC hardening.
--
-- Rollback:
--   Re-apply db/migrations/047_compound_exec_2_persistence_rpc.sql to restore
--   the prior same-key/silent-return behavior.
--
-- This function is deliberately SECURITY INVOKER. The web route calls it with
-- the server-side service-role client, so the RPC can write the commercial
-- ledger atomically without exposing table writes to browser clients.
--
-- Idempotency doctrine:
--   same (user_id, idempotency_key) + same graph_hash -> return existing row
--   same (user_id, idempotency_key) + different graph_hash -> conflict

create or replace function public.create_compound_transaction_from_graph(payload jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_user_id uuid := (payload->>'user_id')::uuid;
  v_mission_id uuid := nullif(payload->>'mission_id', '')::uuid;
  v_session_id text := nullif(payload->>'session_id', '');
  v_idempotency_key text := payload->>'idempotency_key';
  v_graph_hash text := payload->>'graph_hash';
  v_confirmation_digest text := nullif(payload->>'confirmation_digest', '');
  v_currency text := upper(coalesce(nullif(payload->>'currency', ''), 'USD'));
  v_failure_policy text := coalesce(nullif(payload->>'failure_policy', ''), 'rollback');
  v_status text := coalesce(
    nullif(payload->>'status', ''),
    case when nullif(payload->>'confirmation_digest', '') is null
      then 'awaiting_confirmation'
      else 'authorized'
    end
  );
  v_authorized_amount_cents integer := coalesce((payload->>'authorized_amount_cents')::integer, 0);
  v_current_replay_hash text := nullif(payload->>'current_replay_hash', '');
  v_compound_id uuid;
  v_existing record;
  v_leg jsonb;
  v_dependency jsonb;
  v_ordinality bigint;
  v_client_leg_id text;
  v_step_order integer;
  v_transaction_id uuid;
  v_leg_id uuid;
  v_primary_transaction_id uuid;
  v_line_items jsonb;
  v_dep_orders integer[];
  v_leg_map jsonb := '{}'::jsonb;
  v_dependency_leg_id uuid;
  v_dependent_leg_id uuid;
begin
  if jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'INVALID_COMPOUND_REQUEST'
      using hint = 'payload must be a JSON object';
  end if;

  if jsonb_typeof(payload->'legs') is distinct from 'array'
     or jsonb_array_length(payload->'legs') = 0 then
    raise exception 'INVALID_COMPOUND_REQUEST_LEGS'
      using hint = 'payload.legs must be a non-empty array';
  end if;

  if payload ? 'dependencies'
     and jsonb_typeof(payload->'dependencies') is distinct from 'array' then
    raise exception 'INVALID_COMPOUND_REQUEST_DEPENDENCIES'
      using hint = 'payload.dependencies must be an array when provided';
  end if;

  select id, status, graph_hash
    into v_existing
    from public.compound_transactions
   where user_id = v_user_id
     and idempotency_key = v_idempotency_key
   limit 1;

  if found then
    if v_existing.graph_hash is distinct from v_graph_hash then
      raise exception 'INVALID_COMPOUND_GRAPH_HASH_CONFLICT'
        using hint = 'existing_compound_id=' || v_existing.id::text;
    end if;

    return jsonb_build_object(
      'compound_transaction_id', v_existing.id,
      'status', v_existing.status,
      'graph_hash', v_existing.graph_hash,
      'existing', true
    );
  end if;

  insert into public.compound_transactions (
    user_id,
    mission_id,
    session_id,
    idempotency_key,
    graph_hash,
    confirmation_digest,
    status,
    currency,
    authorized_amount_cents,
    failure_policy,
    current_replay_hash,
    evidence
  )
  values (
    v_user_id,
    v_mission_id,
    v_session_id,
    v_idempotency_key,
    v_graph_hash,
    v_confirmation_digest,
    v_status,
    v_currency,
    v_authorized_amount_cents,
    v_failure_policy,
    v_current_replay_hash,
    jsonb_build_object('source', 'compound_exec_2_api')
  )
  returning id into v_compound_id;

  for v_leg, v_ordinality in
    select value, ordinality
      from jsonb_array_elements(payload->'legs') with ordinality
  loop
    v_client_leg_id := v_leg->>'client_leg_id';
    if v_client_leg_id is null or length(v_client_leg_id) = 0 then
      raise exception 'INVALID_COMPOUND_LEG_ID'
        using hint = 'Each leg must include client_leg_id';
    end if;

    v_step_order := coalesce((v_leg->>'step_order')::integer, v_ordinality::integer);
    v_line_items := coalesce(v_leg->'line_items', payload->'line_items', '[]'::jsonb);
    if jsonb_typeof(v_line_items) is distinct from 'array' then
      raise exception 'INVALID_COMPOUND_LEG_LINE_ITEMS'
        using hint = 'line_items must be an array';
    end if;

    select coalesce(array_agg(value::integer order by ordinality), '{}'::integer[])
      into v_dep_orders
      from jsonb_array_elements_text(coalesce(v_leg->'depends_on_orders', '[]'::jsonb))
           with ordinality as deps(value, ordinality);

    insert into public.transactions (
      user_id,
      mission_id,
      agent_id,
      agent_version,
      provider,
      capability_id,
      idempotency_key,
      status,
      currency,
      authorized_amount_cents,
      confirmation_digest,
      line_items,
      compound_transaction_id,
      evidence
    )
    values (
      v_user_id,
      v_mission_id,
      v_leg->>'agent_id',
      coalesce(nullif(v_leg->>'agent_version', ''), '1.0.0'),
      v_leg->>'provider',
      v_leg->>'capability_id',
      coalesce(nullif(v_leg->>'idempotency_key', ''), 'compound:' || v_compound_id::text || ':' || v_client_leg_id),
      v_status,
      upper(coalesce(nullif(v_leg->>'currency', ''), v_currency)),
      coalesce((v_leg->>'amount_cents')::integer, 0),
      v_confirmation_digest,
      v_line_items,
      v_compound_id,
      jsonb_build_object(
        'compound_client_leg_id', v_client_leg_id,
        'source', 'compound_exec_2_api'
      )
    )
    returning id into v_transaction_id;

    if v_primary_transaction_id is null then
      v_primary_transaction_id := v_transaction_id;
    end if;

    insert into public.transaction_legs (
      transaction_id,
      step_order,
      provider,
      capability_id,
      compensation_capability_id,
      idempotency_key,
      status,
      depends_on,
      amount_cents,
      currency,
      evidence
    )
    values (
      v_transaction_id,
      v_step_order,
      v_leg->>'provider',
      v_leg->>'capability_id',
      nullif(v_leg->>'compensation_capability_id', ''),
      coalesce(nullif(v_leg->>'idempotency_key', ''), 'compound:' || v_compound_id::text || ':' || v_client_leg_id || ':leg'),
      'pending',
      v_dep_orders,
      coalesce((v_leg->>'amount_cents')::integer, 0),
      upper(coalesce(nullif(v_leg->>'currency', ''), v_currency)),
      jsonb_build_object(
        'compound_client_leg_id', v_client_leg_id,
        'compensation_kind', coalesce(nullif(v_leg->>'compensation_kind', ''), 'best-effort'),
        'failure_policy', coalesce(nullif(v_leg->>'failure_policy', ''), v_failure_policy)
      )
    )
    returning id into v_leg_id;

    v_leg_map := v_leg_map || jsonb_build_object(
      v_client_leg_id,
      jsonb_build_object(
        'transaction_id', v_transaction_id::text,
        'leg_id', v_leg_id::text,
        'order', v_step_order
      )
    );

    insert into public.leg_status_events (
      compound_transaction_id,
      transaction_id,
      leg_id,
      agent_id,
      capability_id,
      status,
      evidence
    )
    values (
      v_compound_id,
      v_transaction_id,
      v_leg_id,
      v_leg->>'agent_id',
      v_leg->>'capability_id',
      'pending',
      jsonb_build_object('source', 'compound_exec_2_api')
    );
  end loop;

  for v_dependency in
    select value
      from jsonb_array_elements(coalesce(payload->'dependencies', '[]'::jsonb))
  loop
    v_dependency_leg_id := ((v_leg_map -> (v_dependency->>'dependency_client_leg_id')) ->> 'leg_id')::uuid;
    v_dependent_leg_id := ((v_leg_map -> (v_dependency->>'dependent_client_leg_id')) ->> 'leg_id')::uuid;
    if v_dependency_leg_id is null or v_dependent_leg_id is null then
      raise exception 'INVALID_COMPOUND_DEPENDENCY_EDGE'
        using hint = 'Dependency edge references unknown client leg id';
    end if;

    insert into public.compound_transaction_dependencies (
      compound_transaction_id,
      dependency_leg_id,
      dependent_leg_id,
      edge_type,
      evidence
    )
    values (
      v_compound_id,
      v_dependency_leg_id,
      v_dependent_leg_id,
      coalesce(nullif(v_dependency->>'edge_type', ''), 'custom'),
      coalesce(v_dependency->'evidence', '{}'::jsonb)
    );
  end loop;

  if v_primary_transaction_id is not null then
    update public.compound_transactions
       set primary_transaction_id = v_primary_transaction_id
     where id = v_compound_id;
  end if;

  return jsonb_build_object(
    'compound_transaction_id', v_compound_id,
    'status', v_status,
    'graph_hash', v_graph_hash,
    'existing', false
  );
end;
$$;

revoke execute on function public.create_compound_transaction_from_graph(jsonb)
  from anon, authenticated;
grant execute on function public.create_compound_transaction_from_graph(jsonb)
  to service_role;
