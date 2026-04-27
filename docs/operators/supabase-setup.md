# Supabase setup

Lumo uses Supabase for Postgres and auth. This page walks through the setup end-to-end.

## 1. Create a project

[supabase.com](https://supabase.com) → New project. Pick a region close to where Vercel will run (so inter-service latency is low).

Region choice matters more than you might think — a New York Vercel deployment with a Singapore Supabase adds 200+ ms to every DB call, which compounds across the orchestrator loop.

## 2. Note the credentials

Settings → API, save:

- **Project URL** — goes into `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL`.
- **`anon`/public key** — `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **`service_role` secret** — `SUPABASE_SERVICE_ROLE_KEY`. Keep this secret; it bypasses RLS.

## 3. Enable extensions

Database → Extensions. Enable:

- **`vector`** — for pgvector-backed memory embeddings. Required for migration 005 to apply.
- **`pgcrypto`** — usually already enabled; required for `gen_random_uuid()`.

Other extensions aren't used.

## 4. Run migrations

Migrations live under `db/migrations/*.sql` in the Super Agent repo. Apply in order:

### Option A — Supabase CLI (recommended)

```bash
# From the Super Agent repo root
supabase link --project-ref <your-project-ref>
supabase db push
```

The CLI syncs any migration not yet applied. Idempotent — re-running is safe.

### Option B — SQL editor

Copy-paste each file in order into Supabase's SQL editor, select the whole
file (`Cmd+A`), then run it. Do not skip ahead; later migrations assume
earlier tables and functions exist. The whole-file selection matters for
DDL migrations: if the cursor is inside one `CREATE FUNCTION` block, the
editor can run only that focused statement instead of the full migration.
Using `psql` via the pooler/direct connection avoids this ambiguity.

### Option C — Your own migration runner

Anything that runs plain SQL against the database works. The files are pure DDL with a couple of `CREATE OR REPLACE FUNCTION` blocks; no extensions required beyond what step 3 enabled.

After running, verify:

```sql
select table_name from information_schema.tables
where table_schema = 'public'
order by table_name;
```

You should see: `agent_connections`, `autonomous_actions`, `escalations`, `notifications`, `oauth_states`, `ops_cron_runs`, `profiles`, `standing_intents`, `trip_events`, `trips`, `user_autonomy`, `user_behavior_patterns`, `user_facts`, `user_profile`.

Plus the `forget_everything(uuid)` RPC:

```sql
select routine_name from information_schema.routines
where routine_schema = 'public';
-- should include 'forget_everything'
```

## 5. Row Level Security posture

**We run RLS OFF on user data tables.** Explanation:

The Super Agent runs server-side with the service role key and enforces authorization in application code (every route handler that returns user data calls `getServerUser()` and checks `user.id === row.user_id`). RLS would add a second layer but complicates the SSR auth flow — Supabase's `@supabase/ssr` requires specific cookie handling that interacts oddly with RLS when the service role also needs to do cross-user work (platform crons).

The tradeoff:
- **Pro:** simpler codebase, no RLS policy bugs.
- **Con:** any route handler that forgets to filter by user_id is a potential leak. Mitigated by code review + a convention that every user-scoped DAO accepts `user_id` as its first argument.

If your compliance posture requires defense-in-depth, you can enable RLS after the fact — write policies that allow `auth.uid() = user_id` for authenticated users and `current_setting('request.jwt.claim.role') = 'service_role'` for crons. Test thoroughly.

## 6. Auth configuration

Supabase Auth → Providers:

- **Email** (confirm enabled). Disable "Confirm email" if you want users signed in immediately without inbox round-trip (OK for internal deployments; keep on for public).
- **OAuth providers** (Google, GitHub) — optional. If you wire these, the `/login` page shows the extra buttons automatically.

Auth → URL Configuration:

- **Site URL**: `https://lumo.yourco.com` (your deployment).
- **Redirect URLs**: `https://lumo.yourco.com/auth/callback` and `http://localhost:3000/auth/callback` for dev.

Auth → Email Templates: customize if you care. Defaults work.

## 7. Backups

Supabase takes automatic daily backups on all paid tiers. Free tier: manual downloads only.

For production:
- Upgrade to a tier that supports PITR (Point-In-Time Recovery) — lets you restore to any moment within retention.
- Set retention per your compliance needs (7 days is standard; 30 days for stricter regimes).
- **Test a restore once** before you need it. A backup you haven't verified is a hope, not a backup.

Lumo's data model is forgiving under most failures (user memory is editable, connections are re-establishable), but `trips` and `autonomous_actions` rows represent real-world commitments — preserving those is what backups are really for.

## 8. Connection pooling

Supabase exposes two connection strings:

- **Direct** — for migrations and admin work. Limited concurrency.
- **Pooler** — for application traffic. Handles many concurrent connections via PgBouncer.

Use the **pooler** URL for Lumo's runtime queries. On a busy deployment you'll exhaust the direct connection pool otherwise.

In Lumo's code, `lib/db.ts` uses the service role key with the Supabase client, which handles pooling for you. But if you ever add a direct `pg` client (e.g. for a custom cron), use the pooler URL.

## 9. Monitoring

Supabase dashboard → Reports gives you:

- Query performance (slow queries).
- Storage usage.
- Bandwidth.
- Auth signups / sign-ins over time.

Useful for the first month of production. After that you'll mostly check `/ops` on Lumo itself.

Alerts you should set up:

- **Database size approaching quota** — you have a week to upgrade or archive.
- **Connection pool utilization > 80%** — time to scale up or investigate leaks.
- **Auth error rate spike** — usually means a provider is down or your config drifted.

## 10. Local dev Supabase

You can run Supabase locally for development:

```bash
supabase start
```

Gives you a local Postgres + auth on port 54321. Update `.env.local` with the local URLs. Handy for migration development without touching shared environments.

## 11. Schema changes going forward

- **Every schema change goes in a new migration file.** Never edit a committed migration that's been applied to a shared environment.
- **Naming: `NNN_short_description.sql`** where NNN is the next integer.
- **Idempotent where possible.** `CREATE TABLE IF NOT EXISTS`, etc.
- **Backfill logic in separate migrations from schema changes.** Easier to review, easier to roll back.

## 12. Data export

For GDPR / user data requests:

```sql
-- Export everything for a user:
select json_build_object(
  'profile', (select row_to_json(p) from profiles p where p.id = '<user_id>'),
  'user_profile', (select row_to_json(up) from user_profile up where up.user_id = '<user_id>'),
  'facts', (select json_agg(row_to_json(f)) from user_facts f where f.user_id = '<user_id>'),
  'patterns', (select json_agg(row_to_json(bp)) from user_behavior_patterns bp where bp.user_id = '<user_id>'),
  'connections', (
    select json_agg(
      json_build_object(
        'agent_id', agent_id, 'status', status, 'scopes', scopes,
        'connected_at', connected_at, 'last_used_at', last_used_at
        -- omit *_enc columns; they're encrypted and meaningless to the user
      )
    )
    from agent_connections where user_id = '<user_id>'
  ),
  'trips', (select json_agg(row_to_json(t)) from trips t where t.user_id = '<user_id>'),
  'intents', (select json_agg(row_to_json(si)) from standing_intents si where si.user_id = '<user_id>'),
  'autonomy', (select row_to_json(ua) from user_autonomy ua where ua.user_id = '<user_id>'),
  'actions', (select json_agg(row_to_json(aa)) from autonomous_actions aa where aa.user_id = '<user_id>'),
  'notifications', (select json_agg(row_to_json(n)) from notifications n where n.user_id = '<user_id>')
) as export;
```

Paste the output into a JSON file and deliver to the user.

For data deletion, use the `forget_everything(user_id)` RPC for memory plus manual deletes for connections, trips, autonomy, and notifications. Or cascade from `auth.users` if you're deleting the whole account.

## Troubleshooting

**"Migration 005 failed: extension 'vector' does not exist."**
Enable pgvector under Database → Extensions.

**"Migration 006 failed: now() is immutable."**
Old migration had `where ... > now()` in a partial index predicate (not allowed in Postgres). Fixed in the current 006 version. If you hit this, pull the latest 006 and re-run.

**"auth.users table missing."**
Supabase auto-creates this when the first user signs up. If you're running migrations before anyone's signed up, `profiles` may have a dangling FK — sign up once to resolve.

**"Too many connections."**
Switch from direct URL to pooler URL; monitor concurrent function invocations on Vercel.

## Related

- [env-vars.md](env-vars.md) — `SUPABASE_*` env vars.
- [deployment.md](deployment.md) — where Supabase fits in the broader deploy.
- [../architecture/data-model.md](../architecture/data-model.md) — table-by-table schema reference.
