-- Migration 069 — consolidate to the /developer/* portal.
--
-- Two parallel developer surfaces shipped from different sessions:
--   1. /publisher (mine) — partner_developers + partner_agents
--   2. /developer/* (the canonical, marketplace-runtime-wired one) —
--      marketplace_agents + developer_identity_verifications +
--      developer_promotion_requests + developer_webhooks + …
--
-- Direction (per Prasanth, 2026-05-04): keep /developer/*. It sits on
-- lib/marketplace.ts, lib/permissions.ts, lib/marketplace/*,
-- lib/trust/* — i.e., the actual marketplace pipeline. /publisher was
-- a shallower duplicate.
--
-- Also: rename role 'partner' → 'developer' throughout. The product
-- vocabulary is "developer", not "partner".
--
-- This migration is idempotent (IF EXISTS / IF NOT EXISTS), so it's
-- safe to apply whether 064–067 were ever run on this Supabase
-- instance or not. CASCADE on DROP TABLE handles:
--   - the partner_developers→profiles trigger from migration 067
--   - any FK that downstream code might have added against these
--     tables (none expected today)
--   - indexes added by 062, 065, 066

-- 1. Drop the duplicate-portal tables.
drop table if exists partner_agents cascade;
drop table if exists partner_developers cascade;

-- 2. Rename the role value. profiles.role was added by migration 067
-- with values ('user', 'partner', 'admin'). We move 'partner' →
-- 'developer' and tighten the CHECK to the new vocabulary.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'profiles'
       and column_name = 'role'
  ) then
    -- Backfill any existing 'partner' values before we tighten the
    -- CHECK constraint (which would otherwise reject the old value).
    update profiles
       set role = 'developer'
     where role = 'partner';

    -- Drop the old check (named by Postgres convention). We don't
    -- know the exact name pre-migration so use information_schema
    -- to find it. Idempotent.
    perform 1 from pg_constraint where conname = 'profiles_role_check';
    if found then
      alter table profiles drop constraint profiles_role_check;
    end if;

    alter table profiles
      add constraint profiles_role_check
      check (role in ('user', 'developer', 'admin'));
  end if;
end$$;

-- 3. Drop the trigger function from 067 if it's still defined. The
-- trigger itself was dropped by the partner_developers CASCADE
-- above, but the function lingers. Cleaning it up so future grep
-- doesn't find a dead reference to a dropped table.
drop function if exists public.tg_sync_profile_role_from_developer();

comment on column profiles.role is
  'Canonical identity role. user (default), developer (approved publisher in /developer/*), admin (Lumo team). Env allowlists override at request time for bootstrap.';
