# Supabase setup — 15 minutes, one time

Once these steps are done, every Supabase-backed feature in Lumo
lights up: login/signup forms, memory, trip persistence, per-trip
history, connections to downstream agents, the escalation queue,
standing intents, autonomous actions — the works. Until then the
app runs in in-memory mode (chat works, nothing persists across
requests).

---

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**.
2. Pick any name (e.g. `lumo-super-agent`), generate a strong DB
   password, pick a region close to your Vercel deploy region,
   free tier is fine.
3. Wait ~2 minutes for provisioning.

## 2. Copy the four values

Project dashboard → **Settings → API**:

| Label in Supabase | Copy as |
|---|---|
| **Project URL** (e.g. `https://abcxyz.supabase.co`) | URL |
| **anon public** (long JWT starting with `eyJ...`) | Anon key |
| **service_role** (another JWT, marked secret) | Service-role key |

(The URL + anon key are public. The service-role key is secret —
only server-side Vercel functions see it.)

## 3. Set the env vars on Vercel

Vercel dashboard → Project **lumo-super-agent** → **Settings →
Environment Variables** → add all four (scope to
Production **and** Preview **and** Development):

```
NEXT_PUBLIC_SUPABASE_URL        = https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY   = eyJ...            (anon public)
SUPABASE_URL                    = https://<your-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY       = eyJ...            (service_role)
```

Why both `NEXT_PUBLIC_*` and plain: Next.js only inlines
`NEXT_PUBLIC_*` into the browser bundle. The server-side admin
client wants the plain `SUPABASE_*` names.

While you're there, also set:

```
LUMO_ENCRYPTION_KEY             = <any 32-byte base64 string>
```

(Used to encrypt OAuth tokens in `agent_connections` at rest.
Generate with `openssl rand -base64 32` in a terminal.)

Optional — for premium voice:

```
ELEVENLABS_API_KEY              = sk_...            (from elevenlabs.io)
LUMO_ADMIN_TOKEN                = <any long random string>   # gates /api/admin/escalations
OPENAI_API_KEY                  = sk-...            (optional — enables semantic memory recall)
```

## 4. Run the migrations

Supabase dashboard → **SQL Editor** → **New query**.

Paste the contents of **`db/run-all.sql`** (one file, ~1000 lines,
auto-generated from `db/migrations/001…008`) → **Run**.

The script is idempotent — every `CREATE` uses `IF NOT EXISTS` and
every `ALTER` uses `ADD COLUMN IF NOT EXISTS`, so you can re-run
it after a schema update without breaking existing data.

**What this creates:**
- `trips`, `trip_legs`, `events` — trip state + append-only audit log
- `escalations` — queue for trips that need human follow-up
- `profiles`, `agent_connections`, `oauth_states` — user identity + per-user OAuth to agents
- `user_profile`, `user_facts`, `user_behavior_patterns` — memory layer
- `notifications`, `standing_intents` — proactive engine
- `autonomous_actions` — autonomy audit
- `ops_cron_runs` — observability

## 5. Configure Supabase Auth URLs

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL**: `https://lumo-super-agent.vercel.app` (or your custom domain)
- **Redirect URLs**: add `https://lumo-super-agent.vercel.app/auth/callback`
  and `https://lumo-super-agent.vercel.app/**` (wildcard for preview
  deploys if you use them).

Without this, signup confirmation emails land on a blank
Supabase error page instead of coming back to your app.

## 6. Redeploy

Vercel dashboard → **Deployments** → latest → **⋯ → Redeploy**
(uncheck "use existing build cache" so `NEXT_PUBLIC_*` vars get
inlined into the new bundle).

Takes ~90 seconds.

## 7. Verify

Visit `https://lumo-super-agent.vercel.app/` — you should see:

- **Header**: "Sign in" button reappears in the top-right
- **Left rail footer** (desktop): "Create account" and "Sign in"
  buttons stacked
- **Mobile drawer**: same pair at the bottom
- **/login** and **/signup**: real forms, no "not set up" explainer
- **`/api/health`**: returns `{ "status": "ok" }` as before
- **`/api/memory`** (while logged out): returns 401 — confirming the
  auth gate is live (not 500, which would mean env misconfig)

If you sign up and the confirmation email doesn't arrive: check
**Supabase → Authentication → Email Templates** and make sure
the `{{ .ConfirmationURL }}` link still includes your Site URL
from step 5.

---

## Troubleshooting

**"The form submits but nothing happens"**
→ Env vars weren't inlined. Verify on `/login` the explainer page
is gone (it renders when `NEXT_PUBLIC_SUPABASE_URL` is missing).
If it's still there, you need to trigger a fresh build — the
`NEXT_PUBLIC_*` inlining happens at build time, not runtime.

**"Signup says 'email not confirmed' but I can't find the email"**
→ In Supabase dashboard → **Authentication → Providers → Email**
→ temporarily disable "Confirm email" while testing. Re-enable
once you're confident the redirect URL is correct.

**"I see 'row violates RLS policy' errors"**
→ Row Level Security is OFF for these tables by default — they're
server-role-only. If you enabled RLS manually, you'll need
per-table policies. Leave it off until you have a browser-side
read path.

**"/api/memory returns 500 instead of 401 when logged out"**
→ `SUPABASE_SERVICE_ROLE_KEY` isn't set server-side. Double-check
Vercel env var name + scope.
