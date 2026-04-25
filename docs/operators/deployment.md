# Deployment

Standing up a Lumo Super Agent on Vercel + Supabase. End-to-end checklist; if you've done it before, the whole setup is about 45 minutes.

## Prerequisites

- **A domain** you'll point at Lumo (e.g. `lumo.yourco.com`). Lumo can run on the default Vercel `*.vercel.app` subdomain, but OAuth app registration is cleaner with a custom domain.
- **A Supabase account** (free tier is fine for <1000 users; bump tier for production load).
- **A Vercel account** — Pro tier if you want sub-daily crons (proactive scan + intent eval run every 15 minutes on Pro; degrade to daily on Hobby).
- **An Anthropic API key** ([console.anthropic.com](https://console.anthropic.com)).
- **An OpenAI API key** ([platform.openai.com](https://platform.openai.com)) — for embeddings and voice fallback.
- **(Optional) An ElevenLabs account** — for premium voice. Any paid tier works; Free doesn't allow Web API.

## 1. Create the Supabase project

See [supabase-setup.md](supabase-setup.md) for the full walk-through. The 30-second summary:

1. [supabase.com](https://supabase.com) → New project.
2. Save the **Project URL**, **Anon key**, and **Service role key**.
3. Enable the `vector` extension under Database → Extensions (needed for pgvector-backed memory).
4. Run migrations in order: `db/migrations/001_...sql` through `008_...sql`.

## 2. Fork or clone the Super Agent repo

```bash
git clone https://github.com/Prasanth-Kalas/Lumo_Super_Agent.git
cd Lumo_Super_Agent
```

If you plan to add custom agents to the registry, fork first — you'll commit to your fork.

## 3. Deploy to Vercel

From the repo root:

```bash
npx vercel link
npx vercel
```

First deploy will fail because env vars aren't set yet. That's expected. You'll wire them next.

## 4. Set environment variables

All in the Vercel dashboard → Settings → Environment Variables. Full reference: [env-vars.md](env-vars.md).

**Minimum required:**

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
LUMO_ENCRYPTION_KEY=<64 hex chars — generate with: openssl rand -hex 32>
CRON_SECRET=<random bearer token — generate with: openssl rand -hex 32>
```

**Admin-gated ops dashboard** (set to your email):
```
LUMO_ADMIN_EMAILS=you@yourco.com
```

**Voice** (optional — ElevenLabs first, OpenAI fallback):
```
ELEVENLABS_API_KEY=...
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=cedar
```

**OAuth providers** (each optional — omit to hide that provider's card from marketplace):
```
LUMO_GOOGLE_CLIENT_ID=...
LUMO_GOOGLE_CLIENT_SECRET=...
LUMO_MICROSOFT_CLIENT_ID=...
LUMO_MICROSOFT_CLIENT_SECRET=...
LUMO_SPOTIFY_CLIENT_ID=...
LUMO_SPOTIFY_CLIENT_SECRET=...
```

Provider app registration: see [oauth-apps/google.md](oauth-apps/google.md), [microsoft.md](oauth-apps/microsoft.md), [spotify.md](oauth-apps/spotify.md).

**Sensitive-marking guidance:**
- Mark `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LUMO_ENCRYPTION_KEY`, `CRON_SECRET`, `ELEVENLABS_API_KEY`, and all `*_CLIENT_SECRET` env vars as Sensitive.
- `NEXT_PUBLIC_*` vars are by definition not sensitive (they're baked into the client bundle).
- Non-sensitive non-public (like `LUMO_GOOGLE_CLIENT_ID`): Sensitive in production, not required but harmless in preview.

**Environments to set for:** Production + Preview. Development if you do local dev.

## 5. Redeploy

```bash
npx vercel --prod
```

Or push to your git main branch if Vercel auto-deploy is wired.

Once Ready, visit your deployment URL. You should land on `/landing` or `/login`. Sign up with your email (the one in `LUMO_ADMIN_EMAILS`), complete Supabase email confirmation, and you're in.

## 6. Configure the custom domain

Vercel dashboard → Domains → add `lumo.yourco.com` (or whatever). Follow the DNS instructions — a CNAME typically.

**Important:** update every OAuth app's redirect URI to the new domain:
- Google Cloud Console → Credentials → OAuth 2.0 Client ID → edit redirect URIs.
- Azure Entra ID → App registrations → Authentication → edit redirect URIs.
- Spotify Developer Dashboard → App → Edit settings → edit redirect URIs.

Forgetting to update these is the most common post-deploy bug. The OAuth flow will redirect to the old URL and fail with "redirect_uri_mismatch".

## 7. Verify each OAuth provider

For every provider you've configured:

1. Visit `/marketplace` on your deployment.
2. Click Connect on the provider's card.
3. Complete the provider consent flow.
4. Confirm you land on `/connections?connected=1` with a green banner.
5. Try a real query in chat that uses the integration.

If any step fails, check the matching [oauth-apps/](oauth-apps/) guide and the browser console for error details.

## 8. Verify cron jobs

Once the deployment has been live for 15+ minutes, visit `/ops`. Each cron should show a green health card with at least one Ready run.

If `/ops` shows "unauthorized", your `LUMO_ADMIN_EMAILS` env var doesn't include your current signed-in email. Set it, redeploy, re-check.

If a cron is red:
- Check Vercel's Cron tab (Project → Cron Jobs) — are they scheduled?
- Check Vercel logs for the matching endpoint — is it returning 401 (wrong CRON_SECRET) or 5xx (app error)?

## 9. Enable TLS + HSTS

Vercel handles TLS automatically. For extra hardening:

- Add `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` header in `next.config.ts` if not already present.
- Consider adding `Content-Security-Policy` if you know the exact upstream set (ElevenLabs, Anthropic, OpenAI, Supabase, OAuth providers). CSP is picky — test in report-only mode first.

## 10. Set up logging retention

Vercel retains logs per your plan. For longer retention, forward to:
- **Datadog** — add the Vercel Datadog integration.
- **Logflare** — native Vercel integration.
- **Self-hosted** — stream logs via Vercel Webhooks to your collector.

Lumo does not emit user content to logs (see [../architecture/observability.md](../architecture/observability.md)). Logs are safe to retain without special redaction.

## Upgrading

When a new Super Agent version is released:

1. Pull the new code into your fork (or track upstream main).
2. Check the changelog for breaking changes and migrations.
3. Apply new database migrations via `supabase db push` or equivalent.
4. Update any new env vars (the diff between `.env.example` and your current env is a reliable signal).
5. Deploy.

Migration files are strictly additive (we don't edit applied migrations). Schema updates are safe to run live in almost all cases; exceptions are flagged in the migration header comments.

## Multi-region, HA, scaling

Vercel handles scaling out of the box — Lumo is stateless Next.js. Supabase handles DB scaling via their tiers.

Considerations:
- **Cron jobs.** Vercel Cron runs from a single region. Your Supabase region should be close to minimize latency.
- **Function timeout.** Long tool calls (30s+) hit Vercel's default timeout. Bump via `maxDuration` in `app/api/chat/route.ts` if needed; cap at whatever your Vercel plan allows.
- **Database connection pooling.** If you see "too many connections" in logs, switch from the direct Postgres URL to Supabase's pooler (PgBouncer) URL.

## Local dev

```bash
cp .env.example .env.local
# Fill in the same env vars (can share keys with preview)
npm install
npm run dev
```

Runs on `http://localhost:3000`. For OAuth flows to work locally, register each provider app with `http://localhost:3000/api/connections/callback` as an additional redirect URI.

## Related

- [env-vars.md](env-vars.md) — full reference.
- [supabase-setup.md](supabase-setup.md) — detailed Supabase steps.
- [oauth-apps/](oauth-apps/) — per-provider app creation.
- [incident-runbook.md](incident-runbook.md) — what to do when deploy goes sideways.
