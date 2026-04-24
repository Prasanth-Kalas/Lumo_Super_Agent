# Running Lumo

This section is for the person (or team) responsible for deploying and operating a Lumo Super Agent instance. Whether you're self-hosting for your organization or running the managed deployment, the operational surface is the same.

## In this section

- **[Deployment](deployment.md)** — Standing up a Lumo deployment on Vercel.
- **[Environment variables](env-vars.md)** — Every `LUMO_*` and `NEXT_PUBLIC_*` variable, what it's for, and whether it's required.
- **[Supabase setup](supabase-setup.md)** — Project creation, extensions, migrations, RLS posture, backups.
- **[Crons](crons.md)** — What the three cron jobs do, how to monitor them, what to do when they fail.
- **[Observability](observability.md)** — The `/ops` dashboard, admin gating, log patterns to watch for.
- **[Incident runbook](incident-runbook.md)** — What to do when things break, by symptom.
- **OAuth app setup:**
  - [Google](oauth-apps/google.md)
  - [Microsoft](oauth-apps/microsoft.md)
  - [Spotify](oauth-apps/spotify.md)

## Who's this section for

- **DevOps / SRE** at a company self-hosting Lumo for its workforce.
- **The solo founder** running the managed Lumo deployment.
- **An engineer adding a new OAuth provider** who needs to understand how env vars, redirect URIs, and the callback handler all fit together.

It's NOT for end users (send them to [users/](../users/README.md)) or agent developers (send them to [developers/](../developers/README.md)).

## The operational model

Lumo is a **single-tenant Next.js app** backed by Supabase. One deployment serves one user population. There's no multi-tenancy in the app itself — if you want to run Lumo for multiple isolated orgs, run multiple deployments.

Each deployment has:

- **One Vercel project** (or whatever Node host you prefer) running the Super Agent.
- **One Supabase project** for auth + Postgres.
- **One set of provider OAuth apps** (Google, Microsoft, Spotify) with a redirect URI pointing at your deployment.
- **One set of env vars** tying it all together.

Keeping this to "one" of each is the usual answer. Dev / staging / prod are separate deployments.

## The four promises your operations must uphold

1. **Tokens stay sealed.** `LUMO_ENCRYPTION_KEY` is 32 bytes of random hex, never stored in git, never shared across environments. Rotate only with a documented mass-reconnect plan.
2. **Crons actually run.** Proactive scans and intent evaluations are what keep Lumo feeling alive between user turns. If the `/ops` dashboard shows red on a cron, fix it same-day.
3. **No provider content persists.** Lumo's code enforces this (no tables exist for provider data), but your infrastructure choices can violate it — don't log request bodies, don't mirror the database to third-party analytics, don't backdoor a cache somewhere.
4. **Signed-out is a real state.** Middleware bounces unauth'd users to `/login`. Keep it that way; no "soft-auth" mode where a partial identity leaks.

## Expected ops workload

Under normal conditions, Lumo is low-maintenance. A typical week for an operator:

- ~5 minutes glancing at `/ops` for cron health and error rates.
- ~0 incidents if upstream providers are stable.
- ~0 emergencies — the failure modes are mostly "upstream is flaky" which Lumo degrades around.

The heavy ops work happens once, at setup (env vars, OAuth apps, domain), and during version upgrades (schema migrations). Day-to-day is quiet.

## When to escalate

- **Data loss** — if any user-facing data disappears unexpectedly, this is P1. Check Supabase backups, check deployment logs, check the user's actual browser state (localStorage wipes look like data loss from the user's end).
- **Suspected token leak** — P0. Kill-switch everyone, rotate `LUMO_ENCRYPTION_KEY`, force mass-reconnect.
- **Cron silence > 24 hours** — indicates proactive features are fully broken. P2 unless users are complaining.
- **Elevated autonomous-action failure rate** — agent or provider is misbehaving. P2.

Detailed playbooks: [incident-runbook.md](incident-runbook.md).
