# Deepgram Token Contract

Status: contract-frozen

## Endpoint

`POST /api/audio/deepgram-token`

Auth: required Supabase session cookie.

Rate limit: 30 token grants per authenticated user/IP pair per 60 seconds. Over-limit returns `429`.

## Purpose

Clients never receive `LUMO_DEEPGRAM_API_KEY`. They call this endpoint to receive a short-lived Deepgram bearer token suitable for realtime Listen/Speak connections.

The server mints tokens with Deepgram's Auth Grant endpoint and a 60 second TTL. Deepgram grants these temporary tokens `usage:write` for core voice APIs; they are not Manage API keys.

## Request

No JSON body is required.

```http
POST /api/audio/deepgram-token
cookie: <Supabase session>
```

## Success Response

Status: `200`

```json
{
  "token": "<deepgram-temporary-jwt>",
  "expires_at": "2026-05-02T12:00:00.000Z"
}
```

`expires_at` is ISO 8601 UTC with fractional seconds. Clients should refresh before this instant.

## Error Responses

```json
{ "error": "not_authenticated" }
```

Status: `401`. The user is not signed in.

```json
{ "error": "forbidden" }
```

Status: `403`. The auth layer denied the request.

```json
{ "error": "rate_limited", "retry_after_seconds": 42 }
```

Status: `429`. The response also includes `Retry-After`.

```json
{ "error": "deepgram_not_configured" }
```

Status: `503`. `LUMO_DEEPGRAM_API_KEY` is missing.

```json
{ "error": "deepgram_token_error" }
```

Status: `502`. Deepgram rejected or failed the token grant call.

## Client Rules

- Treat the token as memory-only. Do not persist in Keychain, localStorage, logs, screenshots, or crash reports.
- Refresh at 50 seconds after issue or immediately after any provider expiry response.
- Do not call Deepgram with `LUMO_DEEPGRAM_API_KEY`; only use the temporary token from this endpoint.
- On `401`, return to the app login/session refresh flow.
- On `429`, wait for `retry_after_seconds`.
- On `503`, show the existing "voice unavailable" fallback state.
