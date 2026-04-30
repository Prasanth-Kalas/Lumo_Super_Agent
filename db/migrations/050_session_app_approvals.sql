-- APP-INSTALL-IDEMPOTENT-2 — per-session app approvals.
-- NOTE: This is intentionally migration 050. Migration 049 is reserved for
-- CHAT-SUGGESTED-CHIPS-1's events_frame_type_check update.
--
-- Rollback:
--   drop policy if exists session_app_approvals_select_own on public.session_app_approvals;
--   drop index if exists public.session_app_approvals_by_agent_recent;
--   drop index if exists public.session_app_approvals_by_user_session;
--   drop table if exists public.session_app_approvals;

create table if not exists public.session_app_approvals (
  session_id text not null check (
    length(session_id) between 1 and 200
    and session_id !~ '[[:space:]]'
  ),
  agent_id text not null check (
    length(agent_id) between 1 and 160
    and agent_id !~ '[[:space:]]'
  ),
  user_id uuid not null references public.profiles(id) on delete cascade,
  approved_at timestamptz not null default now(),
  granted_scopes text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, agent_id)
);

comment on table public.session_app_approvals is
  'Per-chat-session approval ledger for marketplace apps approved from the inline Lumo mission card.';
comment on column public.session_app_approvals.granted_scopes is
  'Array of approved scope/profile-field labels. This is evidence only; runtime scope enforcement remains in PERM-1 grants and app installs.';

-- Normalize the unreleased 049 draft if it was applied to staging during review.
do $$
declare
  primary_key_name text;
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'session_app_approvals'
      and column_name = 'granted_scopes'
      and udt_name = 'jsonb'
  ) then
    alter table public.session_app_approvals
      add column if not exists granted_scopes_text text[] not null default '{}'::text[];

    update public.session_app_approvals
       set granted_scopes_text = coalesce(
         (
           select array_agg(scope_text order by scope_text)
             from jsonb_array_elements_text(granted_scopes) as scope(scope_text)
         ),
         '{}'::text[]
       );

    alter table public.session_app_approvals drop column granted_scopes;
    alter table public.session_app_approvals rename column granted_scopes_text to granted_scopes;
  end if;

  drop index if exists public.session_app_approvals_by_session;
  drop index if exists public.session_app_approvals_by_agent_recent;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'session_app_approvals'
      and column_name = 'revoked_at'
  ) then
    alter table public.session_app_approvals drop column revoked_at;
  end if;

  select conname
    into primary_key_name
    from pg_constraint
   where conrelid = 'public.session_app_approvals'::regclass
     and contype = 'p'
   limit 1;

  if primary_key_name is not null then
    execute format(
      'alter table public.session_app_approvals drop constraint %I',
      primary_key_name
    );
  end if;

  alter table public.session_app_approvals
    drop constraint if exists session_app_approvals_user_id_session_id_agent_id_key;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'session_app_approvals'
      and column_name = 'id'
  ) then
    alter table public.session_app_approvals drop column id;
  end if;

  delete from public.session_app_approvals a
   using public.session_app_approvals b
   where a.ctid < b.ctid
     and a.session_id = b.session_id
     and a.agent_id = b.agent_id;

  alter table public.session_app_approvals
    add constraint session_app_approvals_pkey primary key (session_id, agent_id);
end $$;

create index if not exists session_app_approvals_by_user_session
  on public.session_app_approvals (user_id, session_id, approved_at desc);

create index if not exists session_app_approvals_by_agent_recent
  on public.session_app_approvals (agent_id, approved_at desc);

drop trigger if exists session_app_approvals_touch_updated_at on public.session_app_approvals;
create trigger session_app_approvals_touch_updated_at
  before update on public.session_app_approvals
  for each row execute function public.touch_updated_at();

alter table public.session_app_approvals enable row level security;
revoke all on public.session_app_approvals from anon, authenticated;
grant all on public.session_app_approvals to service_role;

grant select on public.session_app_approvals to authenticated;

drop policy if exists session_app_approvals_select_own on public.session_app_approvals;
create policy session_app_approvals_select_own on public.session_app_approvals
  for select
  to authenticated
  using (user_id = (select auth.uid()));
