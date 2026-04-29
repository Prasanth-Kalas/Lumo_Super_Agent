-- Migration 038 — MARKETPLACE-1 distribution schema.
--
-- Extends the PERM-1 marketplace_agents stub from migration 037. This
-- migration intentionally uses ALTER TABLE for marketplace_agents; do not
-- recreate that table.
--
-- Rollback:
--   drop trigger if exists marketplace_agent_categories_touch_updated_at on public.marketplace_agent_categories;
--   drop trigger if exists marketplace_agent_tags_touch_updated_at on public.marketplace_agent_tags;
--   drop trigger if exists marketplace_agent_versions_touch_updated_at on public.marketplace_agent_versions;
--   drop trigger if exists agent_ratings_touch_updated_at on public.agent_ratings;
--   drop trigger if exists marketplace_yanked_versions_touch_updated_at on public.marketplace_yanked_versions;
--   drop trigger if exists marketplace_lumos_picks_touch_updated_at on public.marketplace_lumos_picks;
--   drop trigger if exists marketplace_agents_search_vector_refresh on public.marketplace_agents;
--   drop function if exists public.marketplace_agents_refresh_search_vector();
--   drop index if exists public.marketplace_agents_search_vector_idx;
--   drop index if exists public.marketplace_agents_published;
--   drop index if exists public.marketplace_agents_by_category;
--   drop index if exists public.marketplace_agents_by_state;
--   drop index if exists public.marketplace_agent_versions_active;
--   drop index if exists public.marketplace_agent_versions_yanked;
--   drop index if exists public.marketplace_install_metrics_by_agent_window;
--   drop index if exists public.marketplace_yanked_versions_open;
--   drop table if exists public.marketplace_lumos_picks;
--   drop table if exists public.marketplace_yanked_versions;
--   drop table if exists public.marketplace_install_metrics;
--   drop table if exists public.agent_ratings;
--   drop table if exists public.agent_security_reviews;
--   drop table if exists public.marketplace_agent_versions;
--   drop table if exists public.marketplace_agent_tags;
--   drop table if exists public.marketplace_agent_categories;
--   alter table public.marketplace_agents drop column if exists current_version;
--   alter table public.marketplace_agents drop column if exists pinned_minimum;
--   alter table public.marketplace_agents drop column if exists trust_tier;
--   alter table public.marketplace_agents drop column if exists state;
--   alter table public.marketplace_agents drop column if exists category;
--   alter table public.marketplace_agents drop column if exists install_count;
--   alter table public.marketplace_agents drop column if exists install_velocity_7d;
--   alter table public.marketplace_agents drop column if exists rating_avg;
--   alter table public.marketplace_agents drop column if exists rating_count;
--   alter table public.marketplace_agents drop column if exists bundle_sha256;
--   alter table public.marketplace_agents drop column if exists bundle_path;
--   alter table public.marketplace_agents drop column if exists price_usd;
--   alter table public.marketplace_agents drop column if exists billing_period;
--   alter table public.marketplace_agents drop column if exists revenue_split_pct;
--   alter table public.marketplace_agents drop column if exists author_email;
--   alter table public.marketplace_agents drop column if exists author_name;
--   alter table public.marketplace_agents drop column if exists author_url;
--   alter table public.marketplace_agents drop column if exists homepage;
--   alter table public.marketplace_agents drop column if exists privacy_url;
--   alter table public.marketplace_agents drop column if exists support_url;
--   alter table public.marketplace_agents drop column if exists data_retention_policy;
--   alter table public.marketplace_agents drop column if exists tags;
--   alter table public.marketplace_agents drop column if exists search_vector;
--   alter table public.marketplace_agents drop column if exists published_at;
--   alter table public.marketplace_agents drop column if exists withdrawn_at;
--   alter table public.marketplace_agents drop column if exists tenant_scope;

create extension if not exists pg_trgm;

alter table public.marketplace_agents
  add column if not exists current_version       text,
  add column if not exists pinned_minimum        text,
  add column if not exists trust_tier            text not null default 'experimental'
    check (trust_tier in ('official','verified','community','experimental')),
  add column if not exists state                 text not null default 'pending_review'
    check (state in ('pending_review','published','yanked','killed','withdrawn')),
  add column if not exists category              text,
  add column if not exists install_count         integer not null default 0 check (install_count >= 0),
  add column if not exists install_velocity_7d   numeric(12,4) not null default 0 check (install_velocity_7d >= 0),
  add column if not exists rating_avg            numeric(3,2) check (rating_avg is null or (rating_avg >= 1 and rating_avg <= 5)),
  add column if not exists rating_count          integer not null default 0 check (rating_count >= 0),
  add column if not exists bundle_sha256         text,
  add column if not exists bundle_path           text,
  add column if not exists price_usd             numeric(10,2) not null default 0 check (price_usd >= 0),
  add column if not exists billing_period        text not null default 'one_time'
    check (billing_period in ('one_time','monthly','annual','metered')),
  add column if not exists revenue_split_pct     numeric(5,2) not null default 0
    check (revenue_split_pct >= 0 and revenue_split_pct <= 100),
  add column if not exists author_email          text,
  add column if not exists author_name           text,
  add column if not exists author_url            text,
  add column if not exists homepage              text,
  add column if not exists privacy_url           text,
  add column if not exists support_url           text,
  add column if not exists data_retention_policy text,
  add column if not exists tags                  text[] not null default '{}'::text[],
  add column if not exists search_vector         tsvector,
  add column if not exists published_at          timestamptz,
  add column if not exists withdrawn_at          timestamptz,
  add column if not exists tenant_scope          text not null default 'public'
    check (tenant_scope in ('public','private','enterprise'));

create index if not exists marketplace_agents_published
  on public.marketplace_agents (trust_tier, install_count desc, agent_id)
  where state = 'published' and killed = false;

create index if not exists marketplace_agents_by_category
  on public.marketplace_agents (category, install_count desc, agent_id)
  where state = 'published' and killed = false;

create index if not exists marketplace_agents_by_state
  on public.marketplace_agents (state, updated_at desc);

create index if not exists marketplace_agents_search_vector_idx
  on public.marketplace_agents using gin (search_vector);

create or replace function public.marketplace_agents_refresh_search_vector()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.agent_id, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.manifest->>'name', '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.manifest->>'description', '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.manifest->'listing'->>'one_liner', '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.author_name, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(new.category, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(array_to_string(new.tags, ' '), '')), 'D');
  return new;
end;
$$;

drop trigger if exists marketplace_agents_search_vector_refresh on public.marketplace_agents;
create trigger marketplace_agents_search_vector_refresh
  before insert or update on public.marketplace_agents
  for each row execute function public.marketplace_agents_refresh_search_vector();

update public.marketplace_agents
set search_vector =
  setweight(to_tsvector('english', coalesce(agent_id, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(manifest->>'name', '')), 'A') ||
  setweight(to_tsvector('english', coalesce(manifest->>'description', '')), 'B') ||
  setweight(to_tsvector('english', coalesce(manifest->'listing'->>'one_liner', '')), 'B') ||
  setweight(to_tsvector('english', coalesce(author_name, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(category, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'D');

create table if not exists public.marketplace_agent_categories (
  slug        text primary key,
  label       text not null,
  sort_order  integer not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.marketplace_agent_categories (slug, label, sort_order)
values
  ('productivity', 'Productivity', 10),
  ('finance', 'Finance', 20),
  ('travel', 'Travel', 30),
  ('communication', 'Communication', 40),
  ('lumo-rentals', 'Lumo Rentals', 50),
  ('other', 'Other', 999)
on conflict (slug) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    active = true,
    updated_at = now();

drop trigger if exists marketplace_agent_categories_touch_updated_at on public.marketplace_agent_categories;
create trigger marketplace_agent_categories_touch_updated_at
  before update on public.marketplace_agent_categories
  for each row execute function public.touch_updated_at();

create table if not exists public.marketplace_agent_tags (
  slug        text primary key,
  label       text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists marketplace_agent_tags_touch_updated_at on public.marketplace_agent_tags;
create trigger marketplace_agent_tags_touch_updated_at
  before update on public.marketplace_agent_tags
  for each row execute function public.touch_updated_at();

create table if not exists public.marketplace_agent_versions (
  agent_id             text not null references public.marketplace_agents(agent_id) on delete cascade,
  version              text not null,
  manifest             jsonb not null,
  bundle_path          text not null,
  bundle_sha256        text not null check (bundle_sha256 ~ '^[a-f0-9]{64}$'),
  bundle_size_bytes    bigint check (bundle_size_bytes is null or bundle_size_bytes >= 0),
  signature            text,
  signature_verified   boolean not null default false,
  review_state         text not null default 'pending_review'
    check (review_state in ('pending_review','automated_passed','approved','rejected','needs_changes')),
  published_at         timestamptz,
  submitted_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  yanked               boolean not null default false,
  yanked_reason        text,
  yanked_at            timestamptz,
  yanked_by            uuid references public.profiles(id) on delete set null,
  primary key (agent_id, version),
  check ((yanked = false and yanked_at is null) or (yanked = true and yanked_at is not null))
);

create index if not exists marketplace_agent_versions_active
  on public.marketplace_agent_versions (agent_id, published_at desc, version desc)
  where yanked = false;

create index if not exists marketplace_agent_versions_yanked
  on public.marketplace_agent_versions (agent_id, yanked_at desc)
  where yanked = true;

drop trigger if exists marketplace_agent_versions_touch_updated_at on public.marketplace_agent_versions;
create trigger marketplace_agent_versions_touch_updated_at
  before update on public.marketplace_agent_versions
  for each row execute function public.touch_updated_at();

create table if not exists public.agent_security_reviews (
  agent_id       text not null,
  agent_version  text not null,
  reviewer       text not null,
  reviewed_at    timestamptz not null default now(),
  outcome        text not null check (outcome in ('approved','rejected','needs_changes')),
  notes          text,
  evidence       jsonb not null default '{}'::jsonb,
  primary key (agent_id, agent_version),
  foreign key (agent_id, agent_version)
    references public.marketplace_agent_versions(agent_id, version)
    on delete cascade
);

create table if not exists public.agent_ratings (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  agent_id    text not null references public.marketplace_agents(agent_id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  review_text text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, agent_id)
);

drop trigger if exists agent_ratings_touch_updated_at on public.agent_ratings;
create trigger agent_ratings_touch_updated_at
  before update on public.agent_ratings
  for each row execute function public.touch_updated_at();

create table if not exists public.marketplace_install_metrics (
  id           bigint generated by default as identity primary key,
  agent_id     text not null references public.marketplace_agents(agent_id) on delete cascade,
  user_id      uuid references public.profiles(id) on delete set null,
  event_type   text not null check (event_type in (
                 'view',
                 'detail_view',
                 'install_started',
                 'install_completed',
                 'uninstall_completed',
                 'update_available',
                 'update_completed',
                 'yank_migrated'
               )),
  agent_version text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists marketplace_install_metrics_by_agent_window
  on public.marketplace_install_metrics (agent_id, created_at desc, event_type);

grant usage, select on sequence public.marketplace_install_metrics_id_seq to service_role;

create table if not exists public.marketplace_yanked_versions (
  agent_id          text not null,
  version           text not null,
  yanked_reason     text not null,
  yanked_by         uuid references public.profiles(id) on delete set null,
  yanked_at         timestamptz not null default now(),
  fallback_version  text,
  migration_state   text not null default 'pending'
    check (migration_state in ('pending','migrating','completed','blocked','failed')),
  migrated_count    integer not null default 0 check (migrated_count >= 0),
  blocked_count     integer not null default 0 check (blocked_count >= 0),
  completed_at      timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (agent_id, version),
  foreign key (agent_id, version)
    references public.marketplace_agent_versions(agent_id, version)
    on delete cascade
);

create index if not exists marketplace_yanked_versions_open
  on public.marketplace_yanked_versions (migration_state, yanked_at)
  where migration_state in ('pending','migrating','failed');

drop trigger if exists marketplace_yanked_versions_touch_updated_at on public.marketplace_yanked_versions;
create trigger marketplace_yanked_versions_touch_updated_at
  before update on public.marketplace_yanked_versions
  for each row execute function public.touch_updated_at();

create table if not exists public.marketplace_lumos_picks (
  agent_id     text primary key references public.marketplace_agents(agent_id) on delete cascade,
  sort_order   integer not null default 100,
  label        text,
  active       boolean not null default true,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists marketplace_lumos_picks_touch_updated_at on public.marketplace_lumos_picks;
create trigger marketplace_lumos_picks_touch_updated_at
  before update on public.marketplace_lumos_picks
  for each row execute function public.touch_updated_at();

alter table public.marketplace_agent_categories enable row level security;
alter table public.marketplace_agent_tags enable row level security;
alter table public.marketplace_agent_versions enable row level security;
alter table public.agent_security_reviews enable row level security;
alter table public.agent_ratings enable row level security;
alter table public.marketplace_install_metrics enable row level security;
alter table public.marketplace_yanked_versions enable row level security;
alter table public.marketplace_lumos_picks enable row level security;

revoke all on public.marketplace_agent_categories from anon, authenticated;
revoke all on public.marketplace_agent_tags from anon, authenticated;
revoke all on public.marketplace_agent_versions from anon, authenticated;
revoke all on public.agent_security_reviews from anon, authenticated;
revoke all on public.agent_ratings from anon, authenticated;
revoke all on public.marketplace_install_metrics from anon, authenticated;
revoke all on public.marketplace_yanked_versions from anon, authenticated;
revoke all on public.marketplace_lumos_picks from anon, authenticated;

grant all on public.marketplace_agent_categories to service_role;
grant all on public.marketplace_agent_tags to service_role;
grant all on public.marketplace_agent_versions to service_role;
grant all on public.agent_security_reviews to service_role;
grant all on public.agent_ratings to service_role;
grant all on public.marketplace_install_metrics to service_role;
grant all on public.marketplace_yanked_versions to service_role;
grant all on public.marketplace_lumos_picks to service_role;

grant select on public.marketplace_agent_categories to anon, authenticated;
grant select on public.marketplace_agent_tags to anon, authenticated;
grant select on public.marketplace_agent_versions to anon, authenticated;
grant select on public.agent_ratings to authenticated;
grant select on public.marketplace_lumos_picks to anon, authenticated;

drop policy if exists marketplace_categories_public_read on public.marketplace_agent_categories;
create policy marketplace_categories_public_read on public.marketplace_agent_categories
  for select
  to anon, authenticated
  using (active = true);

drop policy if exists marketplace_tags_public_read on public.marketplace_agent_tags;
create policy marketplace_tags_public_read on public.marketplace_agent_tags
  for select
  to anon, authenticated
  using (active = true);

drop policy if exists marketplace_versions_public_read on public.marketplace_agent_versions;
create policy marketplace_versions_public_read on public.marketplace_agent_versions
  for select
  to anon, authenticated
  using (yanked = false and published_at is not null);

drop policy if exists ratings_self_read on public.agent_ratings;
create policy ratings_self_read on public.agent_ratings
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists ratings_self_write on public.agent_ratings;
create policy ratings_self_write on public.agent_ratings
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists ratings_self_update on public.agent_ratings;
create policy ratings_self_update on public.agent_ratings
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists lumos_picks_public_read on public.marketplace_lumos_picks;
create policy lumos_picks_public_read on public.marketplace_lumos_picks
  for select
  to anon, authenticated
  using (active = true);

drop policy if exists marketplace_agents_public_select on public.marketplace_agents;
drop policy if exists marketplace_public_read on public.marketplace_agents;
create policy marketplace_public_read on public.marketplace_agents
  for select
  to anon, authenticated
  using (state = 'published' and killed = false);
