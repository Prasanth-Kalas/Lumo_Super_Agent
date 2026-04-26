# Environment variables reference

Every env var Lumo reads, what it does, and how to set it.

## Naming convention

- **`NEXT_PUBLIC_*`** — baked into the client bundle. Visible to anyone reading your JS. Use only for values that are genuinely public (e.g. Supabase anon key, which is designed to be public).
- **`LUMO_*`** — Lumo-specific server-side secrets. Keep these sensitive.
- **Unprefixed** — general-purpose (Anthropic, OpenAI, Supabase service key, ElevenLabs). Sensitive.

## Required for every deployment

### `ANTHROPIC_API_KEY`

**Type:** Sensitive
**Required:** Yes
**Purpose:** The model key for the Claude orchestrator. Every chat turn makes at least one call with this key.
**Source:** [console.anthropic.com](https://console.anthropic.com) → API keys.
**Rotation:** Can be rotated any time; old keys are revoked on next use.

### `OPENAI_API_KEY`

**Type:** Sensitive
**Required:** Yes
**Purpose:** Embeddings only (`text-embedding-3-small`). Used by `lib/embeddings.ts` for memory write + query.
**Source:** [platform.openai.com](https://platform.openai.com) → API keys.
**Rotation:** Safe any time. Lumo uses a low-cost embeddings endpoint; cost is minimal.

### `NEXT_PUBLIC_SUPABASE_URL`

**Type:** Not sensitive (public by design)
**Required:** Yes
**Purpose:** Supabase project URL. The client-side auth SDK reads it at load time.
**Source:** Supabase dashboard → Settings → API → Project URL.

### `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**Type:** Not sensitive (public by design)
**Required:** Yes
**Purpose:** Supabase anon key for client-side session hydration.
**Source:** Supabase dashboard → Settings → API → `anon` / `public` key.

### `SUPABASE_URL`

**Type:** Sensitive
**Required:** Yes
**Purpose:** Server-side read of the Supabase URL for service-role calls. Usually identical to `NEXT_PUBLIC_SUPABASE_URL` but kept separate so the server never imports a `NEXT_PUBLIC_*` (which would pull it into the client bundle).

### `SUPABASE_SERVICE_ROLE_KEY`

**Type:** Sensitive
**Required:** Yes
**Purpose:** Service-role key used by the server for privileged operations (bypassing RLS). Read by `lib/db.ts`.
**Source:** Supabase dashboard → Settings → API → `service_role` / `secret` key.
**Rotation:** Requires regenerating in Supabase AND updating this env var. Brief window where in-flight requests may 401.

### `LUMO_ENCRYPTION_KEY`

**Type:** Sensitive
**Required:** Yes
**Purpose:** 32-byte key (hex-encoded, 64 chars) for AES-256-GCM sealing of OAuth tokens at rest. Read by `lib/crypto.ts`.
**Source:** Generate once per environment with:
```
openssl rand -hex 32
```
**Rotation:** ⚠️ Rotating this key **invalidates every `agent_connections` row in the database.** Users will need to reconnect. See [../architecture/oauth-and-tokens.md](../architecture/oauth-and-tokens.md#the-key-is-the-one-non-recoverable-secret).

### `CRON_SECRET`

**Type:** Sensitive
**Required:** Yes (if you use cron)
**Purpose:** Bearer token Vercel Cron sends with scheduled invocations. Our cron handlers verify it and reject anything else.
**Source:** Generate with:
```
openssl rand -hex 32
```
**Rotation:** Update here and in any external services calling your cron endpoints. No client-side dependency.

### `LUMO_ML_SERVICE_JWT_SECRET`

**Type:** Sensitive
**Required:** Yes when `lumo-ml` is enabled in the registry
**Purpose:** HMAC secret used by Lumo Core to sign short-lived service JWTs for the `Lumo_ML_Service` system agent. The same value must be set on the Python service. This is how the Intelligence Layer accepts tool calls without exposing raw user OAuth tokens or app secrets.
**Source:** Generate once per environment with:
```
openssl rand -hex 32
```
**Rotation:** Rotate both the Super Agent and `Lumo_ML_Service` together. In-flight Intelligence Layer calls may fail during the rollout window.

### `LUMO_ML_AGENT_URL`

**Type:** Not sensitive
**Required:** Yes when using `config/agents.registry.vercel.json` with `lumo-ml` enabled
**Purpose:** Public base URL for `Lumo_ML_Service`, used by the registry overlay to fetch `/.well-known/agent.json`, `/openapi.json`, and dispatch tool calls.
**Example:** `https://lumo-ml-service-xxxxx-uc.a.run.app`

### `LUMO_ARCHIVE_INDEXER_ENABLED`

**Type:** Not sensitive
**Required:** No
**Purpose:** Operational kill switch for `/api/cron/index-archive`. Set to `true` to let the cron embed redacted `connector_responses_archive` rows and `audio_transcripts`. Any other value makes the cron report `skipped: "disabled"` without calling `Lumo_ML_Service`.
**Default:** disabled

### `LUMO_ARCHIVE_INDEXER_ROW_LIMIT`

**Type:** Not sensitive
**Required:** No
**Purpose:** Maximum archive rows scanned per indexer run. The database function hard-caps this at 500 to protect spend.
**Default:** `100`

### `LUMO_ARCHIVE_INDEXER_CONCURRENCY`

**Type:** Not sensitive
**Required:** No
**Purpose:** Maximum concurrent `/api/tools/embed` batches sent to `Lumo_ML_Service`.
**Default:** `8`

### `LUMO_ARCHIVE_INDEXER_BATCH_SIZE`

**Type:** Not sensitive
**Required:** No
**Purpose:** Maximum redacted text chunks included in one `/api/tools/embed` call. The ML service caps this at 128.
**Default:** `32`

## OAuth provider credentials

All optional — omit a pair to hide that provider's marketplace card.

### Google

- **`LUMO_GOOGLE_CLIENT_ID`** (sensitive or public — either works; sensitive is safer by default)
- **`LUMO_GOOGLE_CLIENT_SECRET`** (sensitive)

Setup: [oauth-apps/google.md](oauth-apps/google.md).

### Microsoft

- **`LUMO_MICROSOFT_CLIENT_ID`** (sensitive)
- **`LUMO_MICROSOFT_CLIENT_SECRET`** (sensitive) — ⚠️ this is the **Secret Value**, not the Secret ID.

Setup: [oauth-apps/microsoft.md](oauth-apps/microsoft.md).

### Spotify

- **`LUMO_SPOTIFY_CLIENT_ID`** (sensitive)
- **`LUMO_SPOTIFY_CLIENT_SECRET`** (sensitive)

Setup: [oauth-apps/spotify.md](oauth-apps/spotify.md). Note the Premium requirement.

## Optional — voice

### `ELEVENLABS_API_KEY`

**Type:** Sensitive
**Required:** No (omit and voice tries OpenAI TTS, then browser TTS)
**Purpose:** Streaming TTS via ElevenLabs. Read by `app/api/tts/route.ts`.
**Source:** [elevenlabs.io](https://elevenlabs.io) → Profile → API keys.
**Rotation:** Any time; old keys invalidate on next use.

### `OPENAI_API_KEY`

**Type:** Sensitive
**Required:** No for voice, yes for OpenAI-backed fallback features
**Purpose:** Server-side TTS fallback when `ELEVENLABS_API_KEY` is absent or ElevenLabs is unhealthy.
**Source:** [platform.openai.com](https://platform.openai.com) → API keys.
**Rotation:** Any time; old keys invalidate on next use.

### `OPENAI_TTS_MODEL`

**Type:** Not sensitive
**Required:** No
**Default:** `gpt-4o-mini-tts`
**Purpose:** OpenAI speech model for the `/api/tts` fallback path.

### `OPENAI_TTS_VOICE`

**Type:** Not sensitive
**Required:** No
**Default:** `cedar`
**Purpose:** OpenAI voice used by the fallback path when the user-selected ElevenLabs voice ID is not an OpenAI voice.

### `LUMO_PICOVOICE_KEY` *(if wake word enabled)*

**Type:** Sensitive
**Required:** No
**Purpose:** Porcupine wake-word SDK key for "Hey Lumo" detection. Read by `lib/wake-word.ts`.
**Source:** [console.picovoice.ai](https://console.picovoice.ai) → Access keys.

## Optional — admin

### `LUMO_ADMIN_EMAILS`

**Type:** Not sensitive (it's just a list of admin emails)
**Required:** Only if you want `/ops` dashboard access.
**Purpose:** Comma-separated list of emails allowed to view `/ops`.
**Format:** `prasanth@lumo.rentals, ops@lumo.rentals`

## Optional — tunables

### `LUMO_MEMORY_SIMILARITY_THRESHOLD`

**Type:** Not sensitive
**Default:** `0.35`
**Purpose:** Cosine-distance cutoff for fact retrieval. Lower = stricter matching, higher = looser.

### `LUMO_AUTONOMY_DEFAULT_TIER`

**Type:** Not sensitive
**Default:** `cautious`
**Purpose:** What tier new users start at. Other values: `balanced`, `proactive`.

### `LUMO_AUTONOMY_DEFAULT_CAP_CENTS`

**Type:** Not sensitive
**Default:** `10000` ($100)
**Purpose:** Default daily spend cap for new users in cents.

### `BARGE_IN_THRESHOLD`

**Type:** Not sensitive
**Default:** `0.05`
**Purpose:** RMS threshold for barge-in detection. Higher = less sensitive (fewer false triggers), lower = more sensitive.

### `WAKE_WORD_SENSITIVITY`

**Type:** Not sensitive
**Default:** `0.5`
**Purpose:** Porcupine sensitivity. 0.0–1.0. Higher = more false positives; lower = more misses.

## Environment-specific conventions

**Production:**
- All Sensitive vars marked Sensitive in Vercel.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` should be separate keys from dev/preview — easier to rotate independently.
- `LUMO_ENCRYPTION_KEY` MUST be unique to production. Don't reuse across environments.
- OAuth provider apps should be **separate** from dev/preview (separate redirect URIs, separate client IDs).

**Preview:**
- Most vars can mirror production; OAuth app should point at the preview's specific Vercel-assigned URL.
- Or: if all previews share a `*.vercel.app` domain pattern, register one OAuth app covering all preview URLs.

**Development:**
- `.env.local` with the same shape.
- OAuth app should include `http://localhost:3000/api/connections/callback` as an allowed redirect.
- Safe to share `ANTHROPIC_API_KEY` across developers if using a team account with usage limits.

## Checking your env

Lumo fails fast on missing required env vars:

- **Server-side**: a required var being absent throws a clear error at first use (e.g. "LUMO_ENCRYPTION_KEY not set"). Check Vercel logs.
- **Client-side**: `NEXT_PUBLIC_SUPABASE_URL` being absent disables auth UI gracefully — the sign-in / sign-out CTAs hide rather than linking to a broken flow.

For a full audit, visit `/api/health` after deploying; it reports which integrations are configured.

## Never commit env vars

- `.env.local` is in `.gitignore`.
- `.env.production` should never exist in the repo.
- Use Vercel's env management or your secrets manager, always.
- If an env var leaks, rotate the underlying credential; `git filter-branch`ing it out of history is cosmetic — treat the secret as burned.

## Rotation strategy

Rotate annually or on any suspected leak:

- **Quarterly:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `CRON_SECRET`.
- **Never unless necessary:** `LUMO_ENCRYPTION_KEY` (requires mass reconnect).
- **On leak suspicion:** all of the above, plus `SUPABASE_SERVICE_ROLE_KEY`.

Always rotate with a brief deploy window — the running deployment holds a cached copy; the new key becomes fully active after redeploy.
