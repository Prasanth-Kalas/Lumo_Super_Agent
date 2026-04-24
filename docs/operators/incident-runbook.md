# Incident runbook

Playbooks by symptom. When something is on fire, open this page, find the closest match, follow it.

## Severity guide

- **P0** — suspected data exposure / token leak, or total outage of the deployment.
- **P1** — major user-facing feature down (chat can't complete, Sign-in broken, all OAuth connections failing).
- **P2** — partial feature down (one provider broken, cron silent, voice offline but chat works).
- **P3** — degraded performance, cosmetic issues, noisy logs without user impact.

## P0 — suspected token leak

Symptoms: a secret appears in a log, a third party reports access to an account they shouldn't have, or you discover a misconfiguration that could have exposed `LUMO_ENCRYPTION_KEY`.

**Immediate actions (minutes matter):**

1. **Rotate `LUMO_ENCRYPTION_KEY`** in Vercel env. Generate new: `openssl rand -hex 32`.
2. **Mass-revoke all connections**. In Supabase SQL editor:
   ```sql
   update agent_connections
   set status = 'revoked', revoked_at = now(),
       access_token_enc = null, refresh_token_enc = null
   where status = 'active';
   ```
3. **Redeploy** so the new key is live.
4. **Force user re-auth.** Users will find their connections broken (status=revoked) and reconnect.

**Then:**

5. Rotate `SUPABASE_SERVICE_ROLE_KEY`.
6. Rotate `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, any provider client secrets.
7. If tokens were demonstrably exfiltrated, notify affected users per your deployment's disclosure policy and applicable regulations (GDPR within 72 hours, etc.).
8. Conduct a post-incident review. Document root cause, timeline, and preventive changes.

**Do NOT:**

- Rotate `LUMO_ENCRYPTION_KEY` without revoking connections first. Users' `agent_connections` rows become undecryptable garbage.
- Share the new key in Slack / email — use your secrets manager.

## P0 — total outage

Symptoms: `/` returns 5xx, no one can sign in, health check fails.

**Check in order:**

1. **Vercel dashboard** — is the deployment "Ready" or "Failed"?
2. **Supabase dashboard** — is the project up?
3. **Anthropic status** — [status.anthropic.com](https://status.anthropic.com).
4. **Domain DNS** — `dig lumo.yourco.com`, verify resolution is correct.

**Most common causes:**

- **Recent deployment introduced a build error.** Roll back via Vercel → Deployments → Promote previous Ready deployment to production.
- **Environment variable deleted accidentally.** Check env vars in Vercel; restore missing ones.
- **Supabase in maintenance or degraded.** Wait; users will see graceful "can't reach db" messages if you've wired those (Lumo's default auth flow handles it gracefully — middleware lets signed-out users through).

**If you can't find the cause in 10 minutes:**

- Roll back the latest deployment (safe default).
- Post a status update ("We're investigating an outage").
- Work the problem on a sandbox deployment without time pressure.

## P1 — Sign-in broken

Symptoms: users land on `/login`, submit, and come back to the same page or get "something went wrong".

**Check:**

1. **Supabase Auth enabled?** Dashboard → Authentication → Providers. Email provider should be "Enabled".
2. **Redirect URLs correct?** Auth → URL Configuration. Site URL should be your current deployment URL.
3. **`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` set?** Client can't hydrate auth without them. Check that they're in Vercel env with NEXT_PUBLIC_ prefix.
4. **Middleware loop?** If `/login` keeps bouncing, the middleware may be confused. Check logs for redirect spam.

**Fix**: usually re-add a missing env var or re-sync Supabase URL config.

## P1 — OAuth connection fails for all users

Symptoms: every user clicking Connect on a provider card bounces back with an error.

**First check**: is it just one provider or all?

### Single provider

Most common: redirect URI mismatch. Provider app's allowed redirects don't include your current deployment URL.

```
https://<your-deployment>/api/connections/callback
```

Must be in the provider's app config exactly. Trailing slashes, `https` vs `http`, subdomain — all matter.

**Google**: Console → Credentials → OAuth 2.0 Client ID → edit.
**Microsoft**: Azure → App registrations → your app → Authentication → edit redirect URIs.
**Spotify**: Developer Dashboard → your app → Edit settings.

### All providers

Probably a Lumo-side issue. Check:

1. `LUMO_ENCRYPTION_KEY` is set and is a 64-char hex string.
2. `CRON_SECRET` is set (not directly used, but missing env vars sometimes cause build issues).
3. Callback handler is being reached — check Vercel logs for `GET /api/connections/callback`.

## P1 — Chat returns "model unavailable" for every user

Claude upstream issue or your key is broken.

**Check:**

1. [status.anthropic.com](https://status.anthropic.com).
2. Your Anthropic console — are you out of credits / has the key been revoked?
3. Vercel logs — is the error really `anthropic_*` or something else misattributed?

**Fix:**

- Wait (if Anthropic is degraded).
- Top up credits.
- Regenerate `ANTHROPIC_API_KEY` in console and update Vercel env.

## P2 — Cron silent for > 1 hour

Symptoms: `/ops` cron card is red or amber. `ops_cron_runs` has no recent rows.

**Check in order:**

1. **Vercel Cron tab** — are they scheduled and running?
2. **Cron response codes in logs** — 401 means `CRON_SECRET` mismatch.
3. **Function logs for the cron endpoint** — does the handler reach completion?
4. **Database connectivity** — crons write to Supabase; if Supabase is slow, they'll timeout.

**Common fixes:**

- Vercel paused cron on deploy; unpause it.
- `CRON_SECRET` got rotated without being updated on one side.
- Function timeout increased needed (edit `maxDuration` in the route).

## P2 — Voice mode silent

ElevenLabs issue.

**Check:**

```bash
curl -X POST https://your-deployment/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "test"}' \
  -w "Status: %{http_code}\n"
```

- **200** → works; the issue is client-side. Tell user to reload (clears the 60-second cooldown).
- **402** → ElevenLabs payment issue. Top up the subscription.
- **401** → your API key is wrong. Check `ELEVENLABS_API_KEY`.
- **503** → key isn't set at all.

## P2 — One provider's OAuth connection fails for one user

Not a platform issue. Usually:

- User changed their password at the provider (refresh token invalidated).
- User revoked Lumo from the provider's own permissions page.
- Provider temporarily blocked the user account.

**Fix**: tell the user to click Reconnect on the marketplace card.

## P3 — Slow response times

Latency creep is usually Supabase or Claude.

**Check:**

1. `/api/chat` average response time in Vercel logs.
2. `ops_cron_runs` duration trend.
3. Supabase reports → slow queries.

**Actions:**

- Supabase slow? Switch to PgBouncer pooler URL.
- Claude slow? Nothing to do — wait for them to recover.
- Memory retrieval slow? Check `user_facts` row count for specific users; if > 10k facts, consider archiving old low-importance facts.

## P3 — React hydration errors in console

Known-issue class. Happens when server-rendered HTML doesn't match client first render. Usually caused by:

- `new Date()` / `Date.now()` / `Math.random()` / `crypto.randomUUID()` in JSX or at render time.
- Locale-dependent formatting (`toLocaleTimeString()`) without explicit locale.
- Values read from `window` / `localStorage` during render.

**Fix**: move those reads into `useEffect`. See recent commit `74e3328` (sessionIdRef fix) as a pattern.

## Post-incident

Every P0 / P1 gets a write-up. Keep it short, honest, actionable:

- **Timeline.** Bullet points with timestamps.
- **Impact.** How many users, how long, what broke.
- **Root cause.** One paragraph.
- **What went well.** Detection, response.
- **What didn't.** Blind spots, slow mitigations.
- **Action items.** With owners and due dates.

Store in a `postmortems/` folder in this repo or a private incidents log. The value isn't the document — it's the discipline of asking "why" three times.

## Related

- [observability.md](observability.md) — how to see signals.
- [crons.md](crons.md) — cron-specific troubleshooting.
- [../architecture/oauth-and-tokens.md](../architecture/oauth-and-tokens.md) — the token-sealing pattern that P0 leak scenarios break.
