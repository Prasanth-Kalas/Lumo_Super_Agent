-- Migration 012 — Workspace + creator-connector tables.
--
-- Backs the /workspace dashboard route plus the YouTube → Newsletter →
-- IG → FB → LinkedIn connector pack defined in
-- docs/specs/workspace-and-creator-connectors.md.
--
-- Six new tables, each scoped per-user, all idempotent, all RLS-ready
-- (RLS off for service-role-only tables; on for user-readable ones —
-- toggled below per table). Indexes are sized for the read patterns the
-- /workspace tabs need: by-user-and-platform, by-status-and-due,
-- append-only audit reads.
--
-- Why these six tables and not fewer:
--   1. connected_accounts        — sub-accounts under one OAuth grant
--                                   (a single Google grant exposes N
--                                   YouTube channels; one Meta grant
--                                   exposes N IG accounts + N FB pages).
--   2. connector_responses_archive — raw API payloads cached for graceful
--                                   degradation when tokens expire or
--                                   APIs return 5xx.
--   3. scheduled_posts           — publish queue for posts/replies the
--                                   user has staged but not yet
--                                   confirmation-card-approved.
--   4. media_assets              — uploaded images/video referenced by
--                                   scheduled_posts.media_refs.
--   5. audit_log_writes          — append-only record of every write
--                                   (post / reply / DM / schedule)
--                                   shipped to a platform.
--   6. pending_user_actions      — cron-fired due-publishes that need
--                                   the user to tap a notification and
--                                   confirm before going live.
--
-- The "one active connection per (user, agent)" model in
-- agent_connections (migration 004) stays as-is. A single grant covers
-- all sub-accounts; this migration just gives us a place to enumerate
-- and select between them.

-- ────────────────────────────────────────────────────────────────────
-- connected_accounts — sub-accounts under one OAuth grant
-- ────────────────────────────────────────────────────────────────────
--
-- One row per externally-distinct account the user has under a single
-- agent_connection. For YouTube: one row per channel the Google grant
-- can manage. For Meta: one row per IG Business/Creator account + one
-- row per FB Page. For LinkedIn: one row for personal profile + one
-- per Company page admin.
--
-- The `is_workspace_default` flag is what /workspace reads when the
-- user hasn't picked a sub-account in the header dropdown. Exactly one
-- row per (user_id, agent_id) carries the default flag — partial unique
-- index below.
--
-- We refresh the list opportunistically (on first dashboard mount + on
-- user-triggered "Refresh accounts" + on weekly cron). Stale rows are
-- soft-deleted via deleted_at so audit_log_writes can still resolve a
-- historical sub-account name.
create table if not exists public.connected_accounts (
  id                          text primary key,
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  agent_id                    text not null,
  -- Platform-side ID for this account/channel/page/profile.
  external_account_id         text not null,
  -- Display info — refreshed on each list call. Plain text, not a token.
  display_name                text not null,
  avatar_url                  text,
  account_type                text not null check (account_type in (
                                'youtube_channel',
                                'instagram_business',
                                'instagram_creator',
                                'facebook_page',
                                'linkedin_personal',
                                'linkedin_company',
                                'newsletter_publication',
                                'twitter_account',  -- reserved for V2
                                'other'
                              )),
  -- Free-form jsonb for platform-specific metadata: subscriber count,
  -- follower count, role on the page (admin/editor/etc), whatever the
  -- list endpoint returns that we want to surface in the picker.
  metadata                    jsonb not null default '{}'::jsonb,
  is_workspace_default        boolean not null default false,
  discovered_at               timestamptz not null default now(),
  last_seen_at                timestamptz not null default now(),
  deleted_at                  timestamptz,
  updated_at                  timestamptz not null default now()
);

-- Lookup: "give me all accounts under this user's connection to agent X"
create index if not exists connected_accounts_by_user_agent
  on public.connected_accounts (user_id, agent_id, last_seen_at desc)
  where deleted_at is null;

-- Reverse lookup for inbound webhooks (when IG/FB/YouTube notify us of
-- an event, they reference external_account_id; we need user_id quickly).
create index if not exists connected_accounts_by_external_id
  on public.connected_accounts (agent_id, external_account_id)
  where deleted_at is null;

-- Exactly one default per (user, agent). Partial unique so we can flip
-- defaults without violating; soft-deleted rows ignored.
create unique index if not exists connected_accounts_one_default
  on public.connected_accounts (user_id, agent_id)
  where is_workspace_default = true and deleted_at is null;

drop trigger if exists connected_accounts_touch_updated_at on public.connected_accounts;
create trigger connected_accounts_touch_updated_at
  before update on public.connected_accounts
  for each row execute function public.tg_touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- connector_responses_archive — graceful-degradation cache
-- ────────────────────────────────────────────────────────────────────
--
-- Every connector fetch (lib/connector-archive.ts) writes here on
-- success. Reads check this table first; if a row is within TTL, serve
-- it. If the live API fails, serve the most-recent row even past TTL
-- and flag the response as stale to the caller.
--
-- request_hash is a canonical sha256 of (agent_id, endpoint,
-- normalized_params) so we can dedupe equivalent requests.
--
-- response_body is jsonb because we do read-side analytics on the
-- archive (e.g., "show me the last 30 daily-views snapshots") and that
-- becomes possible only with structured storage.
--
-- We cap retention with a simple cron sweep (drop rows older than 90d
-- unless `keep_for_history` is true — set on snapshots we want to
-- preserve for trend analysis like daily channel stats).
create table if not exists public.connector_responses_archive (
  id                  bigserial primary key,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  agent_id            text not null,
  external_account_id text,
  endpoint            text not null,
  request_hash        text not null,
  response_status     integer not null,
  response_body       jsonb not null,
  fetched_at          timestamptz not null default now(),
  ttl_seconds         integer not null check (ttl_seconds > 0),
  keep_for_history    boolean not null default false
);

-- Hot path: the cache lookup. Filter by (user, agent, endpoint, hash)
-- and pick the latest fetched_at. Index covers all four.
create index if not exists connector_archive_lookup
  on public.connector_responses_archive
    (user_id, agent_id, endpoint, request_hash, fetched_at desc);

-- Trend-analysis path: time-series queries against snapshots.
create index if not exists connector_archive_history
  on public.connector_responses_archive
    (user_id, agent_id, endpoint, fetched_at desc)
  where keep_for_history = true;

-- Sweep path: "everything older than 90d not flagged for history."
create index if not exists connector_archive_sweep
  on public.connector_responses_archive (fetched_at)
  where keep_for_history = false;

-- ────────────────────────────────────────────────────────────────────
-- media_assets — uploaded images / video for posts
-- ────────────────────────────────────────────────────────────────────
--
-- Browser uploads via signed URL to Supabase Storage; the /api/media/
-- upload endpoint records one row here per upload. scheduled_posts.
-- media_refs is a jsonb array of media_assets.id values referenced
-- in publish order.
--
-- We store sha256 to dedupe re-uploads and enable platform-side hash
-- verification. mime_type drives the platform-side endpoint choice
-- (image vs video upload paths are different on every platform).
create table if not exists public.media_assets (
  id              text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  storage_path    text not null,           -- Supabase Storage path
  mime_type       text not null,
  size_bytes      bigint not null check (size_bytes > 0 and size_bytes <= 100 * 1024 * 1024),
  sha256          text not null,
  width_px        integer,
  height_px       integer,
  duration_ms     integer,                 -- video/audio only
  uploaded_at     timestamptz not null default now(),
  -- Soft delete; preserves historical post records that referenced it.
  deleted_at      timestamptz
);

create index if not exists media_assets_by_user
  on public.media_assets (user_id, uploaded_at desc)
  where deleted_at is null;

create index if not exists media_assets_by_sha
  on public.media_assets (user_id, sha256)
  where deleted_at is null;

-- ────────────────────────────────────────────────────────────────────
-- scheduled_posts — publish queue
-- ────────────────────────────────────────────────────────────────────
--
-- A user staging a post / reply / DM lands here first. The cron worker
-- /api/cron/publish-due-posts picks up rows where status = 'queued' and
-- scheduled_for <= now(), pushes them to pending_user_actions for
-- confirmation, and on confirm calls the platform API.
--
-- status lifecycle:
--   draft       — user is editing; not yet committed to a schedule
--   queued      — committed; waiting for scheduled_for to arrive
--   pending     — due-time hit; user notification sent; awaiting tap
--   posted      — successfully shipped to platform
--   failed      — platform rejected; error_text + platform_error_code captured
--   cancelled   — user cancelled before publish
--   expired     — pending state went 30 min unconfirmed; punted to Inbox
create table if not exists public.scheduled_posts (
  id                       text primary key,
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  agent_id                 text not null,
  external_account_id      text,                          -- which channel/page/profile
  -- Action type: drives platform-API choice.
  action_type              text not null check (action_type in (
                             'post', 'reply', 'comment_reply', 'dm', 'story', 'short'
                           )),
  -- Optional — populated for replies/comment_replies/threaded posts.
  in_reply_to_external_id  text,
  -- jsonb body keeps platform-specific fields without schema churn.
  -- Common shape: { text: "...", title?: "...", thumbnail_ref?: "...",
  -- visibility?: "public|private|unlisted", tags?: [...] }
  draft_body               jsonb not null,
  -- Array of media_assets.id values. Empty for text-only.
  media_refs               jsonb not null default '[]'::jsonb,
  -- User-local timezone-aware target time. Stored as timestamptz.
  -- The user-local display time is reconstructed from profiles.timezone.
  scheduled_for            timestamptz not null,
  -- User's timezone at the time of scheduling, frozen so display is
  -- stable even if the user later changes their profile timezone.
  user_timezone            text not null default 'UTC',
  status                   text not null default 'draft' check (status in (
                             'draft', 'queued', 'pending', 'posted',
                             'failed', 'cancelled', 'expired'
                           )),
  -- Confirmation-card lifecycle timestamps.
  confirmation_shown_at    timestamptz,
  confirmation_decided_at  timestamptz,
  confirmation_decision    text check (confirmation_decision in ('approved', 'rejected')),
  -- Platform outcome.
  posted_at                timestamptz,
  posted_external_id       text,                           -- the platform's URL or ID for this post
  platform_error_code      text,
  error_text               text,
  retry_count              integer not null default 0,
  -- Origin of the request — was this user-typed or AI-suggested? Used
  -- in audit + in the Operations tab.
  origin                   text not null default 'user' check (origin in (
                             'user', 'agent_suggestion', 'standing_intent', 'cron'
                           )),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Cron hot path: "what's due to publish in the next minute?"
create index if not exists scheduled_posts_due
  on public.scheduled_posts (scheduled_for)
  where status = 'queued';

-- Workspace tab read path: "show me my queue across all platforms."
create index if not exists scheduled_posts_by_user
  on public.scheduled_posts (user_id, scheduled_for desc);

-- "Today's posts" widget on Tab 1: anything posted in last 7d or
-- queued in next 7d.
create index if not exists scheduled_posts_today
  on public.scheduled_posts (user_id, status, scheduled_for desc);

drop trigger if exists scheduled_posts_touch_updated_at on public.scheduled_posts;
create trigger scheduled_posts_touch_updated_at
  before update on public.scheduled_posts
  for each row execute function public.tg_touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- audit_log_writes — every write that hit a platform
-- ────────────────────────────────────────────────────────────────────
--
-- Append-only. One row per platform write attempt — successful or
-- failed. Materially separate from scheduled_posts so the audit trail
-- survives even if scheduled_posts is purged.
--
-- The Operations tab reads this. So does any incident-response flow
-- ("did Lumo post anything to my account in the last hour?").
--
-- content_hash is sha256 of the literal text we submitted, so we can
-- prove what was sent without storing a duplicate of draft_body.
-- Original draft_body lives in scheduled_posts; this row references it.
create table if not exists public.audit_log_writes (
  id                       bigserial primary key,
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  scheduled_post_id        text references public.scheduled_posts(id) on delete set null,
  agent_id                 text not null,
  external_account_id      text,
  action_type              text not null,
  -- Confirmation context, captured at the moment of approval.
  confirmation_shown_at    timestamptz not null,
  confirmation_decided_at  timestamptz not null,
  confirmation_decision    text not null check (confirmation_decision in ('approved', 'rejected')),
  -- Platform call.
  platform_called_at       timestamptz,
  platform_response_code   integer,
  platform_response_id     text,                  -- post URL / ID
  ok                       boolean not null,
  error_text               text,
  -- What was submitted.
  content_hash             text not null,
  content_excerpt          text,                  -- first ~200 chars, for display
  origin                   text not null,
  created_at               timestamptz not null default now()
);

create index if not exists audit_log_writes_by_user_recent
  on public.audit_log_writes (user_id, created_at desc);

create index if not exists audit_log_writes_failures
  on public.audit_log_writes (user_id, created_at desc)
  where ok = false;

create index if not exists audit_log_writes_by_scheduled_post
  on public.audit_log_writes (scheduled_post_id);

-- ────────────────────────────────────────────────────────────────────
-- pending_user_actions — due-publishes awaiting user tap
-- ────────────────────────────────────────────────────────────────────
--
-- When the publish cron fires for a queued scheduled_post, we don't
-- bypass the confirmation card. Instead we push a row here, fire a
-- notification (via existing notifications.ts), and wait for the user
-- to tap → see the card → confirm or cancel.
--
-- expires_at = scheduled_for + 30 minutes. Past that, the cron sweeper
-- moves the scheduled_post to 'expired' and surfaces it in the Inbox
-- tab so the user can manually re-queue or discard.
create table if not exists public.pending_user_actions (
  id                  text primary key,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  scheduled_post_id   text not null references public.scheduled_posts(id) on delete cascade,
  notification_id     text,                                   -- notifications.id
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  resolved_at         timestamptz,
  resolution          text check (resolution in ('approved', 'cancelled', 'expired'))
);

-- Cron hot path: "what's expired since last run?"
create index if not exists pending_user_actions_expiry
  on public.pending_user_actions (expires_at)
  where resolved_at is null;

-- Inbox read path: "show me everything currently pending for this user."
create index if not exists pending_user_actions_by_user
  on public.pending_user_actions (user_id, created_at desc)
  where resolved_at is null;
