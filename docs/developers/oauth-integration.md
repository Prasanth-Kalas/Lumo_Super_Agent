# OAuth integration

This page is for agents whose `connect.model` is `"oauth2"` — meaning users connect their own account with a third-party provider (Google, Microsoft, Stripe, Notion, whatever) before your agent can act on their behalf.

## The Lumo side vs. your side

Lumo handles:

- The consent flow (building the authorize URL, capturing the callback, exchanging the code for tokens).
- Token storage (sealed with AES-256-GCM in `agent_connections`).
- Token refresh (on every tool call that's within 5 min of expiry).
- Disconnect (revoke + mark `status='revoked'`).

Your agent handles:

- Accepting an access token on every tool request.
- Calling the provider's API.
- Returning structured results.

You do not write token-storage code. You do not write a "disconnect" flow. You do not run the OAuth callback — Lumo does.

## Declare the `connect` block in your manifest

```ts
connect: {
  model: "oauth2",
  provider: "google",                          // short identifier, used in logs
  authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
  token_url: "https://oauth2.googleapis.com/token",
  revoke_url: "https://oauth2.googleapis.com/revoke",
  scopes: [
    {
      name: "https://www.googleapis.com/auth/gmail.readonly",
      description: "Read your email (never send or modify)",
      required: true,
    },
    {
      name: "https://www.googleapis.com/auth/calendar",
      description: "Read and write calendar events",
      required: true,
    },
    {
      name: "openid",
      description: "Identify you to your agent",
      required: true,
    },
  ],
  client_id_env: "LUMO_MY_AGENT_CLIENT_ID",    // env var name on the Super Agent
  client_secret_env: "LUMO_MY_AGENT_CLIENT_SECRET",
  pkce: "S256",
  refresh_model: "fixed",                       // google/spotify: fixed; microsoft: rotating
}
```

### Scope descriptions are user-facing

The `description` field on each scope appears on the `/marketplace` card's detail page. Write it in plain English, from the user's perspective. "Read your email (never send or modify)" not "mail.readonly scope".

### `required: false` scopes

If you mark a scope `required: false`, Lumo will still request it during consent. The distinction matters if a user denies the optional scope — your tool gets called with a token that lacks it. Your tool should handle that gracefully (return `forbidden` or degrade). Most agents don't need optional scopes; keep the required list tight.

## How tokens reach your tool

When Lumo calls your tool endpoint (`POST {base_url}/api/tools/<op_id>`), it attaches:

```
Authorization: Bearer <provider access token, decrypted>
X-Lumo-User-Id: <lumo user id, uuid>
X-Lumo-Connection-Id: <agent_connections.id, uuid>
X-Lumo-User-Profile: <base64-encoded JSON of relevant profile fields>
```

Your agent's tool handler reads the `Authorization` header, calls the provider API, returns results. No token storage on your side.

```ts
// Your tool handler
export async function POST(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return json(401, { error: { code: "connection_required", message: "No Bearer token" } });
  }
  const accessToken = auth.slice(7);
  // Call provider API with accessToken...
}
```

## Refresh is transparent

If Lumo's token refresh fails (the provider invalidated the refresh token), Lumo marks the connection `expired` and returns `connection_refresh_failed` to the orchestrator **before** calling your tool. You never see an expired token in your handler.

The only provider-level auth error your handler should anticipate is a `401 Unauthorized` from the provider on a call you just made — meaning the token was valid at refresh time but is no longer accepted (user revoked mid-session, for example). In that case, return:

```json
{ "error": { "code": "forbidden", "message": "Provider rejected the token" } }
```

Lumo will mark the connection `expired` and surface the reconnect flow to the user.

## The callback URL — Lumo's side, not yours

The redirect URI you configure in the provider's developer console should point at the **Super Agent**, not your agent:

```
https://{super-agent-domain}/api/connections/callback
```

That's Lumo's OAuth callback. You don't implement one.

## What environment variables look like

Per your manifest's `client_id_env` and `client_secret_env`, the Super Agent expects those names set in its env. For a custom agent calling, say, Notion:

```
LUMO_NOTION_CLIENT_ID=abc123...
LUMO_NOTION_CLIENT_SECRET=secret...
```

Publishing a new OAuth-backed agent means the operator running the Super Agent also needs to:

1. Register an OAuth app with the provider with `https://{super-agent}/api/connections/callback` as an allowed redirect URI.
2. Set the two env vars on Vercel (or whatever host) with the resulting credentials.

See the three per-provider setup guides for examples: [operators/oauth-apps/google.md](../operators/oauth-apps/google.md), [operators/oauth-apps/microsoft.md](../operators/oauth-apps/microsoft.md), [operators/oauth-apps/spotify.md](../operators/oauth-apps/spotify.md).

## PKCE — use S256

Lumo always uses PKCE with S256. Some older providers require `pkce: "none"` or reject S256; set accordingly. Modern providers (Google, Microsoft, Spotify, Notion, Stripe, Slack) all support S256; use it.

## `refresh_model` — rotating vs fixed

- **`"fixed"`** (default): The refresh token stays the same across refreshes. Simpler; most providers work this way.
- **`"rotating"`**: Every refresh returns a new refresh token and invalidates the old one. Microsoft Graph does this. If your manifest says `"fixed"` but the provider actually rotates, Lumo will succeed once then fail the second refresh — tell-tale sign.

## Revocation

If the provider exposes a revoke endpoint, include it in the manifest. On disconnect, Lumo POSTs the tokens to that URL so they die server-side too. Without revoke_url, Lumo only soft-deletes the connection locally — the tokens remain technically valid at the provider until they naturally expire, though they're unreachable without Lumo's encrypted copy.

## Scope changes mid-life

If you add a new scope to an existing agent (because you want a new feature), every user who connected **before** the scope was added still has an active connection without it. Their token requests that need the new scope will return 403. Options:

1. **Degrade gracefully** — detect missing scope and return an error that prompts reconnect.
2. **Force reconnect** — bump the `version` of your manifest major-style; the Super Agent surfaces "reconnect to get new feature" on the marketplace card.

Neither is automatic. Be deliberate.

## Testing OAuth locally

1. Register a **development** OAuth app with the provider. Allowed redirects: `http://localhost:3000/api/connections/callback` plus your public ngrok URL for the Super Agent's callback.
2. Point the Super Agent's env at your dev app's creds.
3. Run the Super Agent and your agent both locally.
4. Connect via `/marketplace` — you'll be bounced to the real provider, consent, and come back.

Common failure: redirect URI mismatch. The URL Lumo sends (`{super-agent-url}/api/connections/callback`) must match **exactly** what's in the provider's app config — trailing slashes, protocol, all of it.

## Provider-specific notes

**Google.** The first authorize call must include `prompt=consent` to issue a refresh token. Subsequent calls without prompt=consent return only an access token. Lumo handles this automatically by including `prompt=consent` when no prior connection exists.

**Microsoft.** Requires `offline_access` scope for refresh tokens. Uses the `common` tenant endpoint so both personal and work accounts work. Rotating refresh tokens — set `refresh_model: "rotating"`.

**Spotify.** Free accounts cannot use Web API at all (provider-side restriction since late 2024). Agent must tolerate 403 on every call until the user upgrades to Premium, or fail fast with a clear message.

**Notion.** Uses bearer tokens that don't expire by default but CAN be revoked via the workspace settings. Health check should verify token validity if long connections matter.

**Stripe.** Different model — OAuth is for Connect accounts. Our generic OAuth manifest works but the flow is bespoke; see Stripe's docs.

## What to do if a provider's auth doesn't fit OAuth 2.1

A few providers still use legacy flows (basic auth, API keys, HMAC signatures). Lumo doesn't support these out of the box in `connect.model: "oauth2"`. Two options:

1. **Proxy through your agent.** Users give your agent their provider API key (stored by you); your agent is `connect.model: "none"` from Lumo's perspective. Not ideal — moves the secrets problem to you.
2. **Custom connect flow.** Open an issue; we'll consider a new `connect.model` variant if the use case is common.

## Related

- [sdk-reference.md](sdk-reference.md#agentconnect--the-auth-contract) — the `AgentConnect` type.
- [../architecture/oauth-and-tokens.md](../architecture/oauth-and-tokens.md) — what's happening on Lumo's side.
- [../operators/oauth-apps/](../operators/oauth-apps/) — how operators register provider apps.
