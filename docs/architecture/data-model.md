# Data model

Every table Lumo uses, what it stores, how it's scoped, and which migration introduced it. SQL source lives under `db/migrations/*.sql`.

## Design principles

- **One Postgres schema** (`public`) — no cross-schema joins, no complex search paths.
- **User-scoped by default** — every table that contains user data has a `user_id uuid` column and a partial index or foreign key on it. Queries are expected to filter by user.
- **No Row-Level Security in v1** — we deliberately run service-role access from the server, and RLS would complicate the SSR auth flow. Access control is enforced in application code (always check `user.id === row.user_id` before return).
- **Soft-delete where history matters; hard-delete where it doesn't.** OAuth connections soft-delete (we want the audit trail). Memory facts hard-delete. Notifications hard-delete after read + TTL.

## Migrations in order

| # | File | What it adds |
|---|---|---|
| 001 | `001_trips_and_events.sql` | `trips`, `trip_events` — the compound-booking saga ledger |
| 002 | `002_cancel_requested.sql` | `cancel_requested_at` column on `trips` |
| 003 | `003_escalations.sql` | `escalations` — support escalation ledger |
| 004 | `004_appstore.sql` | `profiles`, `agent_connections`, `oauth_states` — the Appstore / OAuth foundation |
| 005 | `005_memory.sql` | `user_profile`, `user_facts` (with pgvector 1536-dim embedding), `user_behavior_patterns` + `forget_everything()` RPC |
| 006 | `006_notifications_intents.sql` | `notifications` (partial unique index on `dedup_key`), `standing_intents` |
| 007 | `007_autonomy.sql` | `user_autonomy` (tiers jsonb, daily cap cents, kill-switch), `autonomous_actions` |
| 008 | `008_ops_observability.sql` | `ops_cron_runs` |

Run migrations in sequence via `supabase db push` or your migration runner of choice. Each file is idempotent (`create table if not exists`, `create index if not exists`) so re-running is safe.

---

## Tables

### `profiles`

Identity-shaped data about a user, populated from Supabase Auth and enriched by the onboarding flow.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Matches Supabase `auth.users.id`. |
| `email` | text | Denormalized from auth for convenience. |
| `full_name` | text | |
| `first_name` | text | Extracted for personalized greetings. |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

Populated by the `seedProfile()` helper (`lib/seed-profile.ts`) called on first sign-in.

### `user_profile` (migration 005)

Structured user preferences. Separate from `profiles` because `profiles` is identity and `user_profile` is taste.

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK | FK to `profiles.id`. |
| `timezone` | text | IANA tz, e.g. `America/Los_Angeles`. |
| `language` | text | BCP 47. |
| `display_name` | text | What Lumo calls you. |
| `preferred_airline` | text | Free-form. |
| `preferred_seat` | text | `aisle` / `window` / `any`. |
| `airline_class` | text | `economy` / `business` / `first`. |
| `budget_tier` | text | `budget` / `standard` / `premium`. |
| `extra` | jsonb | Open-ended namespace for features that need state but don't merit a column (e.g. `{ onboarded_at: ... }`). |
| `created_at`, `updated_at` | timestamptz | |

### `user_facts` (migration 005)

Semantic memory. Freeform facts with embeddings for similarity search.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | Indexed. |
| `content` | text | The fact itself. |
| `embedding` | vector(1536) | OpenAI `text-embedding-3-small`. |
| `importance` | real | 0–1 score, learned over repeated mentions. |
| `created_at`, `updated_at` | timestamptz | |

Queried via cosine distance (`<=>` operator from pgvector) combined with a recency and importance boost — see [memory-system.md](memory-system.md) for the retrieval formula.

### `user_behavior_patterns` (migration 005)

Patterns derived from user activity by the nightly `detect-patterns` cron.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `pattern` | text | Human-readable description. |
| `evidence_count` | int | How many data points support this pattern. |
| `first_seen_at`, `last_seen_at` | timestamptz | |

### `forget_everything(uuid)` RPC

Stored procedure (Postgres function) that atomically wipes all memory rows for a user:

```sql
select forget_everything(auth.uid());
```

Deletes rows from `user_facts`, `user_behavior_patterns`, and clears editable fields from `user_profile` (keeping `timezone` + `user_id` since the app needs them).

### `agent_connections` (migration 004)

One row per connected OAuth connection.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | Indexed. |
| `agent_id` | text | Matches a manifest `agent_id`. |
| `status` | text | `active` / `expired` / `revoked` / `error`. |
| `access_token_enc` | bytea | AES-256-GCM ciphertext (iv‖tag‖ct). |
| `refresh_token_enc` | bytea | Same shape. |
| `scopes` | text[] | Granted scopes. |
| `expires_at` | timestamptz | Token expiry. |
| `connected_at` | timestamptz | |
| `last_used_at` | timestamptz | Touched by every decrypt. |
| `revoked_at` | timestamptz | Set on disconnect. |
| `updated_at` | timestamptz | |

The `*_enc` columns hold the IV + auth tag + ciphertext concatenated, Postgres `bytea` with hex-escape encoding on writes (see `bufferToPgEscape` in `lib/connections.ts`). Decryption uses the deployment's `LUMO_ENCRYPTION_KEY`.

### `oauth_states` (migration 004)

Short-lived rows for in-flight OAuth handshakes. PKCE verifier + CSRF state.

| Column | Type | Notes |
|---|---|---|
| `state` | text PK | The CSRF token sent in the authorize URL. |
| `user_id` | uuid FK | |
| `agent_id` | text | |
| `code_verifier` | text | PKCE verifier. |
| `redirect_after` | text | Where to bounce the user post-callback (e.g. `/marketplace?connected=1`). |
| `created_at` | timestamptz | |
| `expires_at` | timestamptz | Typically 10 minutes after creation. |

A small cleanup cron could be added to purge expired rows; in practice volume stays negligible.

### `notifications` (migration 006)

The bell.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `kind` | text | `trip_stuck` / `trip_rolled_back` / `token_expiring` / `intent_triggered` / etc. |
| `title`, `body` | text | What the user sees. |
| `action_url` | text | Optional deep link. |
| `dedup_key` | text | For idempotency. |
| `read_at` | timestamptz | Null until read. |
| `created_at` | timestamptz | |

There's a **partial unique index** on `(user_id, dedup_key)` WHERE `dedup_key IS NOT NULL`, which gives us idempotent inserts — the same underlying event can fire many times and produce one notification.

### `standing_intents` (migration 006)

User-defined recurring jobs.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `title` | text | Display label. |
| `description` | text | Natural-language trigger. |
| `cron` | text | 5-field cron expression (minute hour dom month dow). |
| `tz` | text | IANA tz for the cron. |
| `action_mode` | text | `notify` / `autonomous`. |
| `guardrails` | jsonb | `{ max_actions_per_day, max_spend_cents, lifetime_spend_cents }`. |
| `status` | text | `active` / `paused`. |
| `last_checked_at`, `last_triggered_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz | |

The cron parser is in-house (`lib/standing-intents.ts`) — minute-granular, timezone-aware.

### `user_autonomy` (migration 007)

One row per user, holds the autonomy configuration.

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK | |
| `tier` | text | `cautious` / `balanced` / `proactive`. |
| `tiers` | jsonb | Per-tool-kind overrides — e.g. `{ spend: "balanced", message: "cautious" }`. |
| `daily_cap_cents` | int | |
| `kill_switch_until` | timestamptz | If in the future, autonomy is paused. |
| `updated_at` | timestamptz | |

`tiers` jsonb is how we support finer-grained control (e.g. "balanced for purchases, cautious for messages") without a column explosion.

### `autonomous_actions` (migration 007)

The audit log shown at `/autonomy` below the controls.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `tool` | text | The tool name. |
| `agent_id` | text | |
| `reasoning` | text | Why the autonomy engine approved. |
| `cost_cents` | int | |
| `outcome` | text | `success` / `failed` / `rolled_back`. |
| `fired_at` | timestamptz | |
| `session_id` | uuid | Links back to the conversation. |

### `trips` (migration 001)

Top-level records for compound bookings (flight + hotel + food = one trip).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `session_id` | uuid | Which conversation it was initiated in. |
| `status` | text | `planning` / `dispatching` / `confirmed` / `rolled_back` / `cancelled` / `failed`. |
| `total_cost_cents` | int | |
| `plan_data` | jsonb | The saga plan. |
| `cancel_requested_at` | timestamptz (migration 002) | |
| `created_at`, `updated_at` | timestamptz | |

### `trip_events` (migration 001)

Append-only event log for each trip, the core of the saga pattern.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `trip_id` | uuid FK | Indexed. |
| `event` | text | `leg_dispatched` / `leg_confirmed` / `leg_failed` / `rollback_started` / `cancelled` / etc. |
| `leg_idx` | int | Which leg of the saga. |
| `detail` | jsonb | Payload specific to the event. |
| `at` | timestamptz | |

### `escalations` (migration 003)

Records when Lumo hands something off to a human support channel.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `trip_id` | uuid FK | Optional. |
| `kind` | text | `booking_failed` / `provider_error` / `user_reported` / etc. |
| `payload` | jsonb | Full context. |
| `status` | text | `open` / `resolved`. |
| `created_at`, `resolved_at` | timestamptz | |

Used by internal ops; surfaced in `/api/admin/escalations`.

### `ops_cron_runs` (migration 008)

Per-run record for each cron execution.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `endpoint` | text | `proactive-scan` / `evaluate-intents` / `detect-patterns`. |
| `started_at` | timestamptz | |
| `finished_at` | timestamptz | Nullable — null means still running (or crashed before write-back). |
| `ok` | boolean | Whether the run hit its stable completion path. |
| `counts` | jsonb | Run-specific stats (e.g. `{ users_scanned: 42, intents_fired: 3 }`). |
| `errors` | jsonb | Array of error objects if `ok=false`. |

The `/ops` dashboard reads from this table to render the cron-health cards and histograms.

---

## Entity-relationship shape

```
auth.users
    ↓
profiles  ←→  user_profile  ←→  user_facts
                           ↘   user_behavior_patterns

profiles  ←→  agent_connections  ←→  oauth_states

profiles  ←→  user_autonomy  ←→  autonomous_actions

profiles  ←→  standing_intents  ←→  notifications

profiles  ←→  trips  ←→  trip_events
                    ↘   escalations

ops_cron_runs  (no user scope — platform-level telemetry)
```

All FK → PK relationships point at `profiles.id` (which equals `auth.users.id`), so ON DELETE CASCADE from `auth.users` fans out correctly if a full account is wiped.

---

## Changes and versioning

- New migrations append to `db/migrations/`. Name them `00N_short_description.sql`.
- Never edit a committed migration after it's been applied to a shared environment. Add a new one.
- Every migration should include a comment header explaining the intent and any backfill considerations.
- If adding a column with a default, make the default immutable (`now()` is fine as a DEFAULT on new rows but do NOT use it in a `WHERE` clause on a partial index — Postgres rejects that, as migration 006 learned the hard way before we fixed it in a follow-up).

## Related

- [OAuth + tokens](oauth-and-tokens.md) — how the `*_enc` columns are sealed.
- [Memory system](memory-system.md) — how embeddings are generated and queried.
- [Proactive engine](proactive-engine.md) — what lives in `notifications`, `standing_intents`, `ops_cron_runs`.
