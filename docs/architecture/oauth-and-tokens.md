# OAuth and tokens

Every external integration (Google, Microsoft, Spotify, plus any future third-party agent) uses OAuth 2.1 Authorization Code + PKCE. This page covers the flow end-to-end, how tokens are sealed at rest, and how refresh works transparently.

## The flow

```
  User clicks Connect on /marketplace
           │
           ▼
  POST /api/connections/start
    ├─ Mint PKCE verifier (64-char base64url)
    ├─ Compute code_challenge = SHA256(verifier), base64url
    ├─ Mint CSRF state (32-byte random)
    ├─ Insert oauth_states row:
    │    { state, user_id, agent_id, code_verifier, redirect_after }
    ├─ Build authorize URL:
    │    {provider_authorize_endpoint}
    │      ?response_type=code
    │      &client_id={LUMO_XXX_CLIENT_ID}
    │      &redirect_uri={deployment}/api/connections/callback
    │      &scope={manifest.connect.scopes.join(" ")}
    │      &state={state}
    │      &code_challenge={code_challenge}
    │      &code_challenge_method=S256
    └─ Return { authorize_url }
           │
           ▼
  Client window.location.assign(authorize_url)
           │
           ▼
  [User authenticates at provider, approves scopes]
           │
           ▼
  Provider redirects to /api/connections/callback?code=...&state=...
           │
           ▼
  GET /api/connections/callback
    ├─ Look up oauth_states by state
    │    ├─ Not found → 400 "invalid state"
    │    ├─ Expired  → 400 "expired state"
    │    └─ Found    → pull user_id, agent_id, code_verifier
    ├─ POST provider's token endpoint:
    │    grant_type=authorization_code
    │    code={code}
    │    redirect_uri={deployment}/api/connections/callback
    │    client_id={CLIENT_ID}
    │    client_secret={CLIENT_SECRET}
    │    code_verifier={code_verifier}
    │
    │    → { access_token, refresh_token?, expires_in, scope }
    ├─ Seal access_token + refresh_token with AES-256-GCM
    ├─ Insert agent_connections row:
    │    { user_id, agent_id, access_token_enc, refresh_token_enc,
    │      scopes, expires_at, status='active' }
    ├─ Delete the oauth_states row (one-shot)
    └─ Redirect to redirect_after (default: /connections?connected=1)
```

The whole flow takes ~1 second end-to-end when the provider cooperates. Every step has a specific failure mode, covered below.

## Sealing with AES-256-GCM

`lib/crypto.ts` holds the symmetric cipher implementation:

```ts
export function seal(plaintext: string): Buffer {
  const key = getEncryptionKey();           // 32 bytes from LUMO_ENCRYPTION_KEY
  const iv = crypto.randomBytes(12);        // 96-bit IV, fresh per seal
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();          // 16-byte auth tag
  return Buffer.concat([iv, tag, ct]);      // IV ‖ tag ‖ ciphertext
}
```

Key rules:
- **Key is 32 bytes (AES-256)**, hex-encoded in `LUMO_ENCRYPTION_KEY` (64 hex chars).
- **IV is 96 bits, fresh per call.** Never reused.
- **Auth tag is written with the ciphertext** so tampering produces a clear decryption failure.
- **Decryption throws on auth tag mismatch** — we never try to recover from a corrupted row.

The ciphertext lands in Postgres `bytea` columns. Writes go through `bufferToPgEscape()` which produces the `\x<hex>` literal Postgres expects. Reads come back as Buffers directly.

## The key is the one non-recoverable secret

**If `LUMO_ENCRYPTION_KEY` changes, every existing `agent_connections` row becomes undecryptable.** There is no fallback, no key rotation scheme, no way back. The practical implications:

- Generate the key once per environment. Never change it without also planning a mass reconnect.
- Store it in your secrets manager (Vercel env, AWS Secrets Manager, whatever) with tight access.
- When rotating keys intentionally (e.g. post-breach), run a migration: mark all connections as `revoked`, rotate the env var, force users to reconnect.
- Dev, preview, and production should have **different** keys. Preview and dev use test provider apps so the tokens wouldn't work across environments anyway.

Generate with:
```
openssl rand -hex 32
```

## Refresh flow

Access tokens typically expire in an hour. Lumo refreshes transparently:

1. Before every tool call that uses an OAuth'd agent, `connections.getActiveConnection(userId, agentId)` pulls the row.
2. If `expires_at - now() < 5 minutes`, it triggers a refresh.
3. Refresh POSTs to the provider's token endpoint with `grant_type=refresh_token` and the decrypted refresh token.
4. New tokens get re-sealed and the row updated (new `access_token_enc`, possibly new `refresh_token_enc`, new `expires_at`).
5. The tool call proceeds with the fresh access token.

If refresh fails:
- `400 invalid_grant` → refresh token is dead (user revoked, password changed). Mark connection `status='expired'`, return `connection_refresh_failed` to orchestrator. User sees "reconnect Google" CTA.
- `5xx / network` → transient. Try once, then bail with `connection_refresh_failed` and mark `status='error'` — still shows in `/connections` but with an error badge. Next tool call will retry.

The refresh path is the reason `offline_access` matters on Microsoft and why we request the equivalent on Google. Without a refresh token, Lumo would have to re-prompt users every hour.

## Per-provider quirks

**Google.** Standard OAuth 2.0 + PKCE. Refresh tokens are only issued on the FIRST authorize (when `prompt=consent`); subsequent authorizes return only access tokens. `/api/connections/start` explicitly passes `prompt=consent` on the first-time-ever connect so refresh tokens land.

**Microsoft.** Uses the `common` tenant endpoint so both personal (`@outlook.com`) and work accounts can sign in with one app registration. The provider rejects the token exchange with `AADSTS7000215` if you send the Secret ID instead of the Secret Value — a very easy mistake in the Azure UI. `offline_access` scope is **required** for refresh tokens.

**Spotify.** Standard OAuth 2.0 + PKCE. Access tokens last an hour, refresh tokens are long-lived. The only operational gotcha is the Spotify Premium requirement on the app-owner account as of late 2024 — Spotify returns `402 Payment Required` on all Web API calls from Free-tier apps regardless of the user's plan.

## What the server never sees

- **User passwords.** The consent screens are hosted by the provider. The redirect that comes back carries only an authorization code.
- **Plaintext tokens at rest.** Tokens are sealed before INSERT; they only exist in plaintext in memory during a request.
- **Provider content in the database.** Emails, events, tracks — Lumo fetches on demand and drops at end of turn.

## What the server does see (briefly, in memory)

- The authorization code in the callback (single-use, bound to the redirect URI).
- The plaintext access + refresh tokens, while they're being sealed or used in a request.
- Provider content during a single tool call — e.g. message bodies from Gmail while matching against "did anyone email me about X?". Discarded when the response is sent.

## Disconnection and revocation

At `/connections`, the Disconnect button POSTs `/api/connections/disconnect` with the connection ID. The handler:

1. Verifies the connection belongs to the requesting user.
2. Calls the provider's revoke endpoint if the provider exposes one (Google, Microsoft, Spotify all do — our adapters include the URLs).
3. Updates the row: `status='revoked'`, `revoked_at=now()`, clears `access_token_enc` and `refresh_token_enc` to null (no need to keep ciphertext for a dead token).
4. Returns 204.

The row stays in the table so the user can see it under "Previous connections" at `/connections`. The encrypted tokens are gone.

## Security posture summary

- **Tokens are encrypted at rest** (AES-256-GCM, never the plaintext in DB).
- **PKCE prevents authorization code interception.**
- **State prevents CSRF** on the callback.
- **One-shot state rows** (deleted after use, expire in 10 min) prevent replay.
- **Refresh is transparent**; expired connections are surfaced to the user, not silently retried.
- **Disconnect is immediate** — the row is marked revoked before the UI returns, no eventual-consistency gap.

## Related

- **`lib/crypto.ts`** — seal/open, PKCE helpers (`mintCodeVerifier`, `codeChallengeS256`).
- **`lib/connections.ts`** — the DAO plus refresh orchestration.
- **`app/api/connections/start/route.ts`** and **`.../callback/route.ts`** — the two halves of the flow.
- **[operators/oauth-apps/](../operators/oauth-apps/)** — per-provider app registration guides.
- **[users/privacy.md](../users/privacy.md)** — the user-facing privacy contract this implements.
