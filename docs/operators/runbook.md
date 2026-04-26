# Lumo Production Runbook

Single-page walkthrough for spinning Lumo up from scratch in a fresh
production environment, plus runbooks for the recurring ops tasks once
it's live. Last verified against the state of `main` at commit `7e9e193`
on 2026-04-27.

This file is intentionally a consolidator. The canonical sources stay
in this directory:

- [deployment.md](deployment.md) — Vercel-side bring-up, env wiring, custom domain, OAuth verification.
- [env-vars.md](env-vars.md) — full `LUMO_*` / `NEXT_PUBLIC_*` reference with rotation guidance.
- [supabase-setup.md](supabase-setup.md) — project, extensions, migrations, RLS posture, backups.
- [crons.md](crons.md) — every cron, schedule, monitoring path.
- [observability.md](observability.md) — `/ops` dashboard, log greps, derived metrics.
- [incident-runbook.md](incident-runbook.md) — symptom-first incident playbooks.
- [oauth-apps/](oauth-apps/) — Google, Microsoft, Spotify per-provider setup.

Read this runbook front-to-back the first time you stand a deployment
up. After that, keep it as the table of contents — almost every task
either lives here in summary or links you to one of the canonical docs
above.

---

## What you're standing up

Three deployments, two providers, one optional GPU plane.

- **Lumo Super Agent** on Vercel (Next.js 14, Node 22 runtime, Pro tier
  for sub-daily crons).
- **Lumo ML Service** on Google Cloud Run (FastAPI, Python 3.12, called
  by Super Agent as a system agent over the registry contract).
- **Supabase** Postgres + Storage (managed). Postgres holds every Lumo
  durable table; Storage is unused today but reserved for media artifacts
  if the recall pipeline needs blob storage later.

Plus optional layers, in the order you usually adopt them:

- **Modal** — GPU jobs the brain calls into for Whisper transcription
  (`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`), CLIP image embeddings, and
  the held-out classifier eval scaffold from Phase 1.5.
- **E2B / Firecracker** — sandbox runtime for `run_python_sandbox`.
  Until configured, that tool returns `_lumo_summary` text explaining
  it is not configured and the brain marks the upstream as `degraded`.
- **Google Secret Manager** — eventually you want production secrets
  resolved as Secret Manager references rather than inline
  `--set-env-vars`. Lets you rotate without redeploying both planes
  in lockstep.
- **ElevenLabs** — premium voice. OpenAI TTS is the fallback, browser
  TTS the third tier. Voice mode works without ElevenLabs; it just
  sounds less polished.
- **Picovoice** — wake-word ("Hey Lumo") for hands-free activation.

Everything else (Anthropic, OpenAI, the OAuth provider apps) is required
for the corresponding feature but not separate infrastructure you have
to host.

---

## Prerequisites

Accounts, in the order you'll need them:

- **GitHub**, with access to `Prasanth-Kalas/Lumo_Super_Agent` and
  `Prasanth-Kalas/Lumo_ML_Service`.
- **Vercel**, Pro tier. Hobby technically works but caps crons at daily
  cadence which makes the proactive scan and standing-intent evaluator
  run too rarely to feel alive.
- **Supabase**, Pro tier for production (free tier is fine for staging
  if you accept manual-only backups). Project created; URL, anon key,
  service-role key handy.
- **Google Cloud**, with billing enabled and a project you can deploy
  Cloud Run services to. You will also touch IAM, Cloud Build, and
  optionally Secret Manager.
- **Modal**, with API tokens available if you want Whisper or CLIP.
- **Anthropic**, API key from `console.anthropic.com`.
- **OpenAI**, API key from `platform.openai.com`.
- **ElevenLabs**, paid tier (Free does not allow Web API), if you want
  premium voice.
- One **OAuth provider** account per integration you ship: Google Cloud
  Console for Google Workspace agents, Azure Entra ID for Microsoft 365,
  Spotify Developer Dashboard for Spotify, Meta Developers for Facebook
  and Instagram (this one needs Meta App Review — see
  `docs/specs/meta-app-review-playbook.md`).

CLIs:

- `git` 2.40+.
- `node` 22.x (matches Vercel's runtime; do not deploy from a Node 18
  machine because some `lib/*` bundles compile differently under Node
  20+).
- `npm` 10+.
- `gcloud` with the `run` and `secretmanager` components installed.
- `supabase` CLI (optional — only needed if you want `supabase db push`
  instead of pasting SQL into the Studio).

A working knowledge of: HTTP bearer tokens, public/private keypairs vs.
shared secrets, Vercel's environment-variable model (Production /
Preview / Development), and Cloud Run's "service identity vs. invoker
permissions" model.

Estimated bring-up time for a first-time operator following every step
linearly: 45 minutes if every account is already created, 90 minutes
including account signup and DNS propagation.

---

## First-time bring-up (≈45 min)

The order is deliberate. Each step builds on the previous, and the
verification at the end of each step is the gate that lets you move on.
Skipping ahead is the most common cause of "everything looks wired and
nothing works".

### 1. Apply the database schema

Time: 5–10 minutes.

1. Open the Supabase Studio for your project, then the SQL Editor.
2. Open the file `db/run-all.sql` from a fresh checkout of
   `Lumo_Super_Agent`. As of commit `7e9e193` it is 3117 lines and
   concatenates migrations 001 through 023 in the right order. The
   header banner reads:

       -- Lumo Super Agent — run-all migrations (generated)
       -- Concatenation of db/migrations/001...023 in order. Safe to re-run:
       -- every CREATE uses IF NOT EXISTS and every ALTER uses ADD COLUMN IF NOT EXISTS.

   If you regenerated the file locally, run `node db/build-run-all.mjs`
   first so the banner reflects the latest commit.
3. Paste the whole file into the SQL Editor and Run.
4. If Supabase Studio shows a "destructive operations detected" warning
   dialog, read it carefully. False positives are common — the warning
   matches text inside our rollback comment blocks (every migration
   header has a `-- Rollback:` block listing `drop table if exists ...`
   for clarity, and the linter cannot tell the difference between a
   live `drop` and a commented one). If the only matches are inside
   `--` lines, click "Run anyway".
5. If a "new tables without RLS" warning appears, prefer **"Run and
   enable RLS"** unless the migration file already enables RLS
   explicitly. From migration 015 onward, every Sprint 2 / Sprint 3
   migration enables RLS itself and revokes anon/authenticated grants
   — re-enabling does no harm but you should verify with the audit
   query below.

Verification:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
```

The canonical table set as of commit `7e9e193` is:

```
admin_settings
admin_settings_history
agent_connections
agent_runtime_overrides
agent_tool_usage
anomaly_findings
audio_transcripts
audio_uploads
audit_log_writes
autonomous_actions
connected_accounts
connector_responses_archive
content_embedding_sources
content_embeddings
document_assets
escalations
events
image_assets
image_embeddings
media_assets
mission_execution_events
mission_steps
missions
notifications
oauth_states
ops_cron_runs
partner_agents
pdf_documents
pending_user_actions
preference_events
proactive_moments
profiles
scheduled_posts
standing_intents
time_series_metrics
trip_legs
trips
user_agent_installs
user_autonomy
user_behavior_patterns
user_facts
user_mcp_connections
user_profile
```

That's 43 tables. If you see fewer, a migration silently failed; check
the SQL Editor for the most recent error and re-run from the failing
migration's `--` header forward.

Also verify the helper function set:

```sql
select routine_name
from information_schema.routines
where routine_schema = 'public'
order by routine_name;
```

You should see at least: `forget_everything`, `next_mission_step_for_execution`,
`next_proactive_moment_for_user`, `next_connector_archive_embedding_batch`,
`tg_touch_updated_at`, `touch_updated_at`. The two `touch_updated_at`
variants are deliberate — `tg_touch_updated_at` came in with migration
001 and stays around for trips/trip_legs/etc.; `public.touch_updated_at()`
came in with migration 015 and is what 015 onward use. Do not delete
either.

If pgvector is missing, you will see migration 015 fail with
"extension 'vector' does not exist". Database → Extensions → enable
`vector`, then re-run from 015.

### 2. Configure Lumo Super Agent on Vercel

Time: 10–15 minutes.

The full env reference lives in [env-vars.md](env-vars.md). Inline the
critical short list here so you don't need three tabs open while you
work:

Required:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
LUMO_ENCRYPTION_KEY=<openssl rand -hex 32>
CRON_SECRET=<openssl rand -hex 32>
LUMO_ML_SERVICE_JWT_SECRET=<openssl rand -hex 32>
LUMO_ADMIN_EMAILS=you@yourco.com
```

Mark every key above except the two `NEXT_PUBLIC_*` and
`LUMO_ADMIN_EMAILS` as **Sensitive** in the Vercel UI. The
`NEXT_PUBLIC_*` entries are baked into the client bundle by design.
`LUMO_ADMIN_EMAILS` is just a list of operator emails; not a secret.

Recommended once Cloud Run is up (added in Step 3):

```
LUMO_ML_AGENT_URL=https://<your-cloud-run-lumo-ml-service-url>
```

Optional feature flags (covered in detail in their own runbook entries
below):

```
LUMO_PROACTIVE_SCAN_ENABLED=false
LUMO_ARCHIVE_INDEXER_ENABLED=false
LUMO_ARCHIVE_INDEXER_ROW_LIMIT=100
LUMO_ARCHIVE_INDEXER_BATCH_SIZE=32
LUMO_ARCHIVE_INDEXER_CONCURRENCY=8
```

OAuth provider credentials, each pair is optional — omitting a pair
hides that provider from the marketplace card grid:

```
LUMO_GOOGLE_CLIENT_ID=...
LUMO_GOOGLE_CLIENT_SECRET=...
LUMO_MICROSOFT_CLIENT_ID=...
LUMO_MICROSOFT_CLIENT_SECRET=...
LUMO_SPOTIFY_CLIENT_ID=...
LUMO_SPOTIFY_CLIENT_SECRET=...
```

Voice, optional:

```
ELEVENLABS_API_KEY=...
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=cedar
```

Set every var on **Production** and **Preview** environments. Set
**Development** too if you intend to do `vercel dev` locally; otherwise
leave it blank and use a `.env.local`.

Deploy from the repo root:

```bash
npx vercel link
npx vercel --prod
```

The first deploy will succeed if env vars are wired correctly. If
`/api/health` returns 5xx, look at Vercel's runtime logs for the missing
env name in the error message — Lumo's startup checks fail fast with
clear messages.

Add your custom domain (`lumo.yourco.com` or similar) under Vercel
Project → Domains → Add. CNAME or A-record per Vercel's instructions.
Once DNS propagates and TLS issues, sign up at the deployment URL with
the email in `LUMO_ADMIN_EMAILS`, complete Supabase email confirmation,
and you're in.

### 3. Configure Lumo ML Service on Cloud Run

Time: 15–20 minutes.

From a fresh checkout of `Lumo_ML_Service`:

```bash
gcloud config set project <gcp-project-id>

gcloud run deploy lumo-ml-service \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars \
LUMO_ML_SERVICE_JWT_SECRET=<same-secret-as-super-agent>,\
MODAL_TOKEN_ID=<modal-token-id>,\
MODAL_TOKEN_SECRET=<modal-token-secret>
```

Notes:

- `--allow-unauthenticated` is required so Super Agent (and the
  registry-handshake `curl` you'll do in Step 4) can hit the service
  without a Cloud Run-issued ID token. Authentication happens at the
  application layer via the JWT signed with `LUMO_ML_SERVICE_JWT_SECRET`.
  If your GCP organization policy blocks `allUsers` on Cloud Run, you
  need an exception or you need to ship a Lumo-side proxy that minted
  Cloud Run ID tokens. We have run into this on hardened orgs; the
  workaround is to scope `allUsers` to this single service rather than
  granting it org-wide.
- Pin `LUMO_ML_SERVICE_JWT_SECRET` to the **same** value you set on
  Vercel in Step 2. Different values silently fail with 401 from every
  brain call until you spot the mismatch in logs.
- `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are optional. If absent,
  `/api/health` reports `modal_whisper` as `degraded` and
  `/api/tools/transcribe` returns `status: "not_configured"`. Super
  Agent treats this as a soft failure — audio uploads marked failed,
  no crash.
- Do NOT set `LUMO_ML_PUBLIC_BASE_URL` on the first deploy. The brain
  derives manifest URLs from the incoming request when this is unset,
  which is what you want until you put the service behind a custom
  domain. Set it later only when you front the service with a domain
  like `brain.lumo.yourco.com`.

For production-grade rotation, replace inline `--set-env-vars` with
Secret Manager references. See the "Move secrets to Secret Manager"
recurring runbook below; the short version is that you create one
secret per env name, grant the Cloud Run runtime SA `roles/secretmanager.secretAccessor`,
and then deploy with `--set-secrets` instead of `--set-env-vars`.

### 4. Verify the registry handshake

Time: 5 minutes.

The Super Agent's registry overlay reads the brain's manifest from
`/.well-known/agent.json` and the OpenAPI from `/openapi.json`. If
either is unreachable or has the wrong base URL, the system agent never
appears in the marketplace and tool calls fail.

```bash
BRAIN_URL=https://<your-cloud-run-service>-uc.a.run.app

curl -fsSL "$BRAIN_URL/.well-known/agent.json" | jq '.id, .public_base_url, .endpoints.openapi'
curl -fsSL "$BRAIN_URL/openapi.json" | jq '.info.title, .servers'
curl -fsSL "$BRAIN_URL/api/health" | jq '.status, .upstream'
```

What to expect:

- `id` is `lumo-ml`. (Hardcoded; never changes.)
- `public_base_url` matches `$BRAIN_URL` exactly. If it points at
  `http://localhost:3010`, you set `LUMO_ML_PUBLIC_BASE_URL` to a stale
  value — unset it and redeploy.
- `endpoints.openapi` is `<BRAIN_URL>/openapi.json` and resolves with
  200 above.
- `/api/health` returns `status: "ok"` if `LUMO_ML_SERVICE_JWT_SECRET`
  is set, `degraded` otherwise. The `upstream.sandbox` block stays
  `degraded` until you wire E2B; that is expected and not a deploy
  blocker.

Then verify the Super Agent sees the brain:

1. Sign in to your Vercel preview (or production once you trust the
   wiring) with the admin email.
2. Navigate to `/workspace`.
3. Open the Operations tab.
4. Confirm the **System** badge shows on the "Lumo Intelligence Layer"
   row, and the row is green / Active.

If the System badge shows but the row is amber, the manifest fetch
succeeded but a recent tool call failed. Check Vercel runtime logs for
`[router]` and `[lumo-ml]` entries.

If the row is missing entirely, the registry overlay never loaded — the
most common cause is `LUMO_ML_AGENT_URL` not being set on Vercel
(Step 2), or being set to an HTTPS URL that 404s the manifest path.

### 5. Optional but recommended

These are not bring-up blockers, but the deployment is not "production
ready" until they're done.

- **Wire E2B** to make `run_python_sandbox` actually compute. Without
  it, the tool returns the canned "no sandbox runtime configured"
  response. Inject `E2B_API_KEY` into the Cloud Run service. The
  service does not yet adopt `E2B_API_KEY` automatically (the scaffold
  in `app/tools.py` has a TODO); ship the wiring with a follow-up
  commit before flipping any user-facing toggle.
- **Move secrets to Secret Manager** so JWT rotation does not require
  a coordinated Vercel + Cloud Run redeploy. See the recurring runbook.
- **Enable Sprint 2 / Sprint 3 features** by setting
  `LUMO_ARCHIVE_INDEXER_ENABLED=true` and `LUMO_PROACTIVE_SCAN_ENABLED=true`
  once migration 022 (proactive dedupe) and migration 023 (durable
  missions) are applied. The schema lands well before the cron starts
  doing work; the env flag is the kill switch that gates real activity.
- **Set up logging retention** beyond Vercel's plan default. Datadog,
  Logflare, BetterStack, Axiom — any Vercel-integrated log drain works.
  Lumo never logs user content (chat, tool args, OAuth tokens), so
  logs are safe to retain without redaction. See observability.md for
  the curated grep patterns.
- **Test a Supabase restore** before you need one. A backup you have
  not verified is a hope, not a backup.

---

## Recurring runbooks

The book of "things you do more than once". Each entry is short by
design — link to canonical docs for the details, keep the runbook
itself glanceable while you're solving a live issue.

### Apply a new migration

Time: 5 minutes if it's a small migration, longer for backfills.

1. Pull `main` so you have the latest `db/migrations/<NNN>_*.sql`.
2. Open Supabase SQL Editor → New query.
3. Paste the migration content. If multiple migrations are pending,
   apply them strictly in number order — later migrations assume the
   earlier ones' tables and functions exist.
4. Run.
5. If the **destructive operations** warning fires, read the warning's
   "matched lines" carefully. As of migration 023 every header has a
   `-- Rollback:` comment block listing the drops; those count as
   "destructive matches" but are inert (they are inside `--` lines).
   If the only matches are inside `--` lines, click **Run anyway**.
   Otherwise stop and re-read the migration body — a real
   `drop ... if exists` outside a comment is rare and intentional, but
   you want to know about it before you click through.
6. If a **new tables without RLS** warning fires, prefer **Run and
   enable RLS** unless the migration body already enables RLS. As of
   migration 023, every Sprint 2 / Sprint 3 migration explicitly
   enables RLS and revokes anon/authenticated grants, so the warning
   is over-eager but harmless to acknowledge.
7. Re-run the audit query from Step 1 of bring-up; the new table
   should appear, the row count should match expectations.
8. If the migration was wired with `node db/build-run-all.mjs`,
   regenerate `db/run-all.sql` so future fresh deploys pick the new
   migration up.

After applying, test one feature that uses the new schema before you
declare success. A `select count(*) from <new_table>` returning 0 is
not the same as the writer code having actually inserted a row.

### Rotate the LUMO_ML_SERVICE_JWT_SECRET

Time: 10 minutes; expect a 30-second window of 401s on in-flight calls.

This is the secret both Super Agent (signer) and Lumo ML Service
(verifier) must agree on. Rotate annually, or immediately on any
suspicion of leak.

```bash
NEW=$(openssl rand -hex 32)
echo "$NEW"   # write down or pipe to your secrets manager
```

Rotate Cloud Run first (it is the verifier — until it accepts the new
secret, nothing signed with the new secret will work):

```bash
gcloud run services update lumo-ml-service \
  --region us-central1 \
  --update-env-vars LUMO_ML_SERVICE_JWT_SECRET="$NEW"
```

Then update Vercel:

```bash
vercel env rm  LUMO_ML_SERVICE_JWT_SECRET production
vercel env add LUMO_ML_SERVICE_JWT_SECRET production  # paste $NEW
vercel env rm  LUMO_ML_SERVICE_JWT_SECRET preview
vercel env add LUMO_ML_SERVICE_JWT_SECRET preview     # paste $NEW
vercel --prod
```

In-flight call window:

- The instant after Cloud Run picks up the new secret, any JWT signed
  with the old secret returns 401 from `/api/tools/*`. Vercel's
  previous deploy is still signing with the old secret.
- Once `vercel --prod` finishes and the new deploy goes live, both
  sides agree. Total window: usually 20–60 seconds.
- A handful of users may see "tool unavailable" during that window;
  the Super Agent retries once on 401 with a fresh signed JWT, so most
  flows recover automatically. If you see persistent 401s after 5
  minutes, you have a value mismatch (extra whitespace, wrong env
  setting, etc.) — re-paste both sides.

If you have moved the secret to Secret Manager (recommended), the
rotation is one `gcloud secrets versions add` plus a Vercel env
update; Cloud Run picks up the new version on next request without a
redeploy. Significantly less painful.

### Rotate Modal tokens

Time: 5 minutes.

1. modal.com → Settings → API Tokens.
2. Generate a new pair (`token_id`, `token_secret`).
3. Update Cloud Run:

       gcloud run services update lumo-ml-service \
         --region us-central1 \
         --update-env-vars MODAL_TOKEN_ID=<new-id>,MODAL_TOKEN_SECRET=<new-secret>

4. Revoke the old pair on modal.com.
5. Verify Whisper transcription end-to-end: upload a short audio clip
   in the Lumo workspace and confirm it transcribes. The brain's
   `/api/health` should still show `modal_whisper: "ok"`.

If you forgot to revoke step 4, the old token still works — Modal does
not auto-revoke. Set a calendar reminder to do it.

### Rotate Anthropic / OpenAI / ElevenLabs keys

Time: 5 minutes per key.

1. Generate new key in the provider's console.
2. Update the matching env var on Vercel (Production + Preview).
3. Deploy: `vercel --prod`.
4. Revoke the old key in the provider's console.

These keys are cached at process start, so the new key is live as
soon as the new deploy boots. No coordinated Cloud Run change required
(the brain does not call Anthropic / OpenAI / ElevenLabs directly).

`CRON_SECRET` rotation is identical — generate, replace on Vercel,
redeploy. No external party calls our cron paths in production today
(Vercel Cron supplies the bearer header from the env var
automatically), so there is no third side to update.

### Trigger a cron manually

Useful when:

- You just shipped a fix and want to catch up missed runs.
- You're investigating why proactive moments are not appearing for a
  specific user.
- You want to confirm `CRON_SECRET` is set correctly without waiting
  15 minutes.

The bearer pattern is the same for every cron:

```bash
DEPLOY=https://lumo.yourco.com
SECRET=<value of CRON_SECRET>

curl -X POST "$DEPLOY/api/cron/proactive-scan"   -H "Authorization: Bearer $SECRET"
curl -X POST "$DEPLOY/api/cron/evaluate-intents" -H "Authorization: Bearer $SECRET"
curl -X POST "$DEPLOY/api/cron/detect-patterns"  -H "Authorization: Bearer $SECRET"
curl -X POST "$DEPLOY/api/cron/index-archive"    -H "Authorization: Bearer $SECRET"
curl -X POST "$DEPLOY/api/cron/sync-workspace"   -H "Authorization: Bearer $SECRET"
curl -X POST "$DEPLOY/api/cron/publish-due-posts" -H "Authorization: Bearer $SECRET"
```

Each returns JSON. The shape is consistent: `ok`, `counts`, optional
`errors`, optional `skipped`. A `skipped: "disabled"` body is normal
when the cron's feature flag is off — it is not an error, the cron
ran and exited early on purpose.

For the full schedule + behaviour reference, see [crons.md](crons.md).

### Toggle a feature flag

Two flags currently gate real production work:

- `LUMO_PROACTIVE_SCAN_ENABLED` — when `true`, `/api/cron/proactive-scan`
  groups recent `time_series_metrics`, runs anomaly detection, and
  writes `proactive_moments` rows. When anything else (including
  unset), the cron returns `skipped: "disabled"` immediately.
- `LUMO_ARCHIVE_INDEXER_ENABLED` — when `true`,
  `/api/cron/index-archive` embeds redacted `connector_responses_archive`
  rows and `audio_transcripts` into `content_embeddings`. When
  anything else, the cron returns `skipped: "disabled"` immediately.

To toggle:

1. Vercel → Project → Settings → Environment Variables.
2. Edit the var. Set to `true` to enable, anything else (including
   blank) to disable.
3. Redeploy: `vercel --prod` (or push to main if auto-deploy is
   wired). The flag is read at request time, but your edit only goes
   live for new deploys; `vercel env` edits do not hot-reload running
   functions.

Disabling a flag stops the cron from doing **new** work. It does not
delete in-flight data. Existing `proactive_moments` rows stay, future
ones stop being created. If you want to truly hide a feature from
users, a flag toggle is the start; you may also need to suppress the
UI surface in Vercel.

The full env reference, including the size-tunable flags
(`LUMO_ARCHIVE_INDEXER_ROW_LIMIT`, `_BATCH_SIZE`, `_CONCURRENCY`),
lives in [env-vars.md](env-vars.md).

### Investigate a cron failure

Symptom: `/ops` shows a red or amber card, or `ops_cron_runs` has
`ok=false` rows for an endpoint.

1. Open Vercel runtime logs and filter for the cron's path
   (e.g. `/api/cron/proactive-scan`). The most recent invocation
   shows the response body and stack.
2. In Supabase SQL Editor, query the cron's history:

       select endpoint, started_at, finished_at, ok, counts, errors
       from ops_cron_runs
       where endpoint = '<endpoint>'
         and started_at > now() - interval '24 hours'
       order by started_at desc;

   `errors` is a JSONB array of `{ message, stack }`; the first one
   usually points at the immediate culprit.
3. Common failure patterns:
   - **Missing migration.** The cron writes to a table that does not
     exist yet (e.g. you enabled `LUMO_PROACTIVE_SCAN_ENABLED=true`
     before applying migration 021/022). Apply the migration; the
     cron self-heals.
   - **Expired service JWT.** `index-archive` calls the brain. If
     `LUMO_ML_SERVICE_JWT_SECRET` is mismatched between Super Agent
     and Cloud Run, every embed call returns 401. Fix per the rotation
     runbook above.
   - **Brain unhealthy.** `index-archive` will refuse to call an
     unhealthy brain; you'll see `skipped: "brain_unhealthy"` in the
     response body. See "Investigate a brain unhealthy status" below.
   - **Anthropic outage.** `evaluate-intents` and `detect-patterns`
     both call Claude. If `ANTHROPIC_API_KEY` is wrong or Anthropic
     is degraded, those crons fail. Check
     `status.anthropic.com`.
   - **Function timeout.** A run approaching 30 seconds may be
     timing out. Solutions in [crons.md](crons.md): paginate work,
     bump `maxDuration`, or move to a background-job host.

The function-level details are in [crons.md](crons.md), the
incident-level decision tree is in
[incident-runbook.md](incident-runbook.md) under "P2 — Cron silent for
> 1 hour".

### Investigate a brain unhealthy status

Symptom: `/api/health` on the Cloud Run URL returns
`status: "degraded"`, or the `/workspace` Operations tab shows the
Lumo Intelligence Layer row in amber.

```bash
curl -fsSL "$BRAIN_URL/api/health" | jq
```

The `upstream` block is the first thing to read:

- **`service_jwt: "ok"`** — required. If `degraded`, the service has
  no `LUMO_ML_SERVICE_JWT_SECRET` set and rejects every authenticated
  call. Set it on Cloud Run and redeploy / update.
- **`sandbox: "degraded"`** with `last_error: "E2B/Firecracker runtime
  is not configured in scaffold"` — expected until E2B is wired. Not
  an incident; it's the configured posture.
- **`modal_whisper: "ok"`** / **`modal_clip: "ok"`** — depends on
  `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`. Both keys gate both
  upstreams; setting one without the other gives `degraded` for both.
- **`pdf_extraction: "ok"`** — depends on the `unstructured` Python
  package being installed in the Cloud Run image. If `degraded` with
  `last_error: "unstructured PDF partitioner is not installed"`,
  rebuild the image with the dependency.
- **`analytics_models: "ok"`** — depends on Prophet + scikit-learn
  being installed. If `degraded`, the brain falls back to a
  statistical baseline; not blocking, but worth fixing for production
  forecasting fidelity.

If `service_jwt` is OK but everything else is degraded, the brain is
**functionally healthy** — Super Agent's planning, ranking, and risk
endpoints work; only the GPU-backed compute paths (Whisper, CLIP,
sandbox, PDF) are offline. That is the expected state of a fresh deploy
before you've wired Modal and E2B.

### Move secrets to Secret Manager

Time: 30 minutes one-time.

For each Cloud Run env you currently set with `--set-env-vars`:

```bash
PROJECT=<gcp-project-id>
SECRET=lumo-ml-service-jwt-secret    # name in Secret Manager
VALUE=<the secret value>

gcloud secrets create "$SECRET" --replication-policy=automatic --project "$PROJECT"
echo -n "$VALUE" | gcloud secrets versions add "$SECRET" --data-file=- --project "$PROJECT"

# Grant the Cloud Run runtime SA access. Default SA is
# <project-number>-compute@developer.gserviceaccount.com; use the
# dedicated runtime SA if you've created one.
SA=<runtime-sa-email>
gcloud secrets add-iam-policy-binding "$SECRET" \
  --member="serviceAccount:$SA" \
  --role="roles/secretmanager.secretAccessor" \
  --project "$PROJECT"
```

Then redeploy with `--set-secrets` instead of `--set-env-vars`:

```bash
gcloud run services update lumo-ml-service \
  --region us-central1 \
  --set-secrets LUMO_ML_SERVICE_JWT_SECRET=lumo-ml-service-jwt-secret:latest,\
MODAL_TOKEN_ID=modal-token-id:latest,\
MODAL_TOKEN_SECRET=modal-token-secret:latest
```

After this, rotation is `gcloud secrets versions add ...`; Cloud Run
picks up the new version on next request. Vercel still has its own
copy of `LUMO_ML_SERVICE_JWT_SECRET`, so JWT rotations remain a
two-side update — but Modal token rotations become single-sided.

---

## Failure modes we've seen and fixed

A short, honest list. When the same shape of error shows up again, the
operator who hits it should recognize it from this section and head
straight for the known fix.

- **`.git/index.lock` blocks normal git ops in the Linux sandbox**
  while the macOS host process holds an unkillable lock. Symptom:
  `warning: unable to unlink ... index.lock: Operation not permitted`
  on otherwise-fine `git status`. Workaround: branch operations
  (`checkout -b`, `add`, `commit`) still succeed; the lock affects
  cleanup, not the operation. Long-term fix: don't run two git clients
  against the same repo simultaneously.
- **`touch_updated_at` function name mismatch.** Migration 001 used
  `tg_touch_updated_at()`; migration 015 added `public.touch_updated_at()`
  and 015–023 use that name. If you replay only the new migrations
  against a database that still has the trigger pointing at the old
  name, the trigger no-ops silently. Fix landed in commit `e795cce`
  ("repair migration replay hygiene"); re-run `db/run-all.sql` from
  scratch on a fresh DB or add the function-rename SQL by hand.
- **`bigint = text` cast bugs in 019 and 020.** Original drafts of the
  `pdf_documents` and `image_embeddings` migrations had a join
  predicate that compared a `bigint` column to a `text` ID, which
  Postgres refused without an explicit cast. Fixed in `e795cce`.
  If you hit the original error on an old SQL paste, re-pull `main`.
- **Manifest URL pointing at `localhost:3010` in production.** The
  brain's default `LUMO_ML_PUBLIC_BASE_URL` is `http://localhost:3010`.
  If you accidentally set it explicitly to that value on Cloud Run
  (e.g. by copying a `.env.example` line), the manifest at
  `/.well-known/agent.json` advertises the wrong base URL and
  Super Agent cannot route tool calls. Fix: unset the env var on
  Cloud Run so the service derives it from the request, or set it to
  the actual public Cloud Run URL.
- **Cloud Run org policy blocks `allUsers` invoker.** On hardened GCP
  orgs the deploy completes but the service refuses anonymous traffic,
  every Super Agent call returns 403. Fix: org-admin grants an
  exception scoped to the single `lumo-ml-service`, or you proxy
  through a Lumo-side endpoint that mints Cloud Run ID tokens. Pick
  exception unless your security review forbids it.
- **Supabase Studio "destructive operations" false positive on
  rollback comments.** Migration headers contain `-- Rollback:` blocks
  that list `drop ... if exists` for every object the migration
  creates. The Studio linter pattern-matches the word `drop` without
  understanding `--`, so it warns on every recent migration. Read the
  matched lines; if every match is inside a `--` line, click "Run
  anyway".
- **`package.json` shared between coworker and Codex during Sprint 2
  commits.** Two parallel agent threads each adding a test script to
  `package.json` produced collision diffs that lost one of the
  scripts on merge. Fix: assign `package.json` edits to a single
  thread per sprint, and the brief that issues the second thread's
  work explicitly forbids package.json edits. The Sprint 3 brief
  enforces this — the K4 runbook brief itself lists `package.json`
  in its forbidden-paths list.
- **OAuth callback "duplicate error" toast.** A defensive
  `console.error` on the OAuth callback page double-fired when the
  user reloaded the success page, producing a misleading red toast
  on a successful flow. Fixed in `cfdb809` ("suppress duplicate oauth
  callback error").
- **Mission context lost across follow-up messages.** Sprint 2
  follow-ups occasionally dropped the parent mission ID, causing the
  next user turn to plan a fresh mission instead of continuing the
  existing one. Fixed in `676a4ef` ("preserve mission context across
  followups").
- **Voice TTS overlap and stuck speaking state.** A class of bugs
  (`d4987b2`, `242865e`, `c45efdd`, `0de222b`) where the TTS pipeline
  failed to release locks between turns, leaving the assistant
  appearing to "talk over itself" or freeze in a speaking state. All
  fixed; if you see voice misbehavior, first check ElevenLabs upstream
  and only if that's clean look at client state.

If a new failure mode comes up that took more than 15 minutes to
diagnose, add it here. The bar is "an operator with 24 hours of context
should not have to re-debug this from scratch".

---

## What's NOT in this runbook

- **Sprint 3+ multi-agent coordination** beyond the schema in
  migration 023 (`missions`, `mission_steps`, `mission_execution_events`).
  The execution wiring is the active D2 brief; until it ships,
  durable missions are scaffolding only and the runbook
  intentionally does not document operator workflows that would
  imply otherwise.
- **Multi-Lumo coordination protocols.** When and how multiple Lumo
  deployments would share state across organizations is a future
  spec; today, every deployment is single-tenant.
- **Held-out classifier eval scaffold (Phase 1.5)** beyond the fact
  that it exists and lands in `7e9e193`. Operationalizing the eval
  loop (cadence, tracking, failure thresholds) belongs in a Sprint 4
  brief, not here.
- **Disaster recovery drills.** A formal DR runbook (full-region
  Supabase outage, Cloud Run regional failover, Vercel region pinning)
  is on the roadmap. Today, the implicit DR plan is: Vercel handles
  multi-region failover, Supabase backups land via the configured
  PITR retention, and the operator manually rebuilds Cloud Run in a
  second region if `us-central1` goes down. That is fine for current
  load; it is not a tested DR plan.
- **OAuth provider deep-dives.** Each provider has its own quirks
  (Microsoft's "Secret Value" vs "Secret ID", Spotify's Premium
  requirement, Google's OAuth verification screen). Those live in
  [oauth-apps/google.md](oauth-apps/google.md),
  [oauth-apps/microsoft.md](oauth-apps/microsoft.md),
  [oauth-apps/spotify.md](oauth-apps/spotify.md). The runbook
  delegates rather than duplicates.

For the architecture roadmap, including how durable missions, the
Intelligence Layer, and proactive moments fit together strategically,
read `docs/specs/lumo-intelligence-layer.md`. That document is the
single source of truth for "what we are building"; this runbook is the
single source of truth for "how to keep what's already shipped
running".

---

## Cross-reference index

| Topic                       | Canonical doc                          |
| --------------------------- | -------------------------------------- |
| Vercel deploy + custom domain | [deployment.md](deployment.md)       |
| Every env var               | [env-vars.md](env-vars.md)             |
| Supabase project + RLS      | [supabase-setup.md](supabase-setup.md) |
| Cron schedules + monitoring | [crons.md](crons.md)                   |
| `/ops` dashboard            | [observability.md](observability.md)   |
| Symptom-first incidents     | [incident-runbook.md](incident-runbook.md) |
| OAuth provider apps         | [oauth-apps/](oauth-apps/)             |
| Architecture & roadmap      | `docs/specs/lumo-intelligence-layer.md` |

When in doubt, this runbook is the entry point and the table above is
the index. Edit it sparingly — every link below must keep working.
