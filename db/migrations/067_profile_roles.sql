-- Migration 067 — unified user roles on profiles.
--
-- Three roles capture every identity we deal with:
--
--   user     regular Lumo end-user (default)
--   partner  approved developer — may use /publisher
--   admin    Lumo team — may use /admin
--
-- Today these are scattered: partner-ness lives in
-- partner_developers.tier='approved' OR LUMO_PUBLISHER_EMAILS env;
-- admin-ness lives in LUMO_ADMIN_EMAILS env. This migration adds a
-- single `profiles.role` field as the canonical source, and a
-- trigger that keeps it in sync when partner_developers transitions
-- between application states. Env allowlists still win at request
-- time (resolved in lib/publisher/access.ts) so the Lumo team
-- doesn't have to also touch the DB.
--
-- Role transitions driven by the trigger:
--
--   partner_developers.tier becomes 'approved'
--     → profiles.role := 'partner', UNLESS already 'admin'
--   partner_developers.tier moves OFF 'approved' to
--   'rejected'/'revoked'/'waitlisted'
--     → profiles.role := 'user', UNLESS already 'admin'
--
-- The "unless admin" guard prevents an admin's developer-app state
-- from ever demoting them. Admin assignment stays admin-driven
-- (UPDATE profiles SET role='admin' WHERE email=...), with the env
-- list as bootstrap for the first ones.

alter table profiles
  add column if not exists role text not null default 'user'
    check (role in ('user', 'partner', 'admin'));

create index if not exists profiles_role_idx
  on profiles (role)
  where role <> 'user';

comment on column profiles.role is
  'Canonical identity role. user (default), partner (approved publisher), admin (Lumo team). Env allowlists override at request time for bootstrap.';

-- Backfill existing approved developers to role='partner'. Match by
-- lowercased email (the partner_developers PK convention). We do
-- not touch admins or any profile already non-'user' — that
-- preserves anyone manually elevated before this migration runs.
update profiles p
set role = 'partner'
where p.role = 'user'
  and exists (
    select 1
    from partner_developers d
    where lower(d.email) = lower(p.email)
      and d.tier = 'approved'
  );

create or replace function public.tg_sync_profile_role_from_developer()
returns trigger language plpgsql security definer as $$
declare
  target_email text := lower(coalesce(new.email, old.email));
  next_role    text;
begin
  if (tg_op = 'INSERT' or tg_op = 'UPDATE') then
    if new.tier = 'approved' then
      next_role := 'partner';
    elsif new.tier in ('rejected', 'revoked', 'waitlisted') then
      next_role := 'user';
    else
      return new;
    end if;
  elsif tg_op = 'DELETE' then
    next_role := 'user';
  else
    return new;
  end if;

  -- Never demote (or upgrade-then-overwrite) an admin via a
  -- developer-application change. Admins stay admins.
  update profiles
     set role = next_role,
         updated_at = now()
   where lower(email) = target_email
     and role <> 'admin'
     and role is distinct from next_role;

  return coalesce(new, old);
end;
$$;

drop trigger if exists partner_developers_role_sync on partner_developers;
create trigger partner_developers_role_sync
  after insert or update of tier or delete on partner_developers
  for each row execute function public.tg_sync_profile_role_from_developer();
