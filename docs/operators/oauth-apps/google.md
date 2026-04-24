# Google integration — Gmail · Calendar · Contacts

One OAuth app, three integrations. The Lumo Super Agent treats this as a **personal integration** — read-heavy, never persisted. Tokens are stored per-user in `agent_connections` (AES-256-GCM encrypted at rest); tool results pass through to Claude and are forgotten at turn end.

## 1. Create a Google Cloud project

1. https://console.cloud.google.com → create a new project (or select one).
2. **APIs & Services → Enabled APIs & Services → Enable APIs and Services**, enable each:
   - Gmail API
   - Google Calendar API
   - People API

## 2. Configure the OAuth consent screen

- **APIs & Services → OAuth consent screen**
- User type: **External** (Internal only works for Google Workspace).
- Fill in app name (e.g. "Lumo"), support email, developer email.
- Scopes — add these by their string form (or pick from the list):
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/calendar`
  - `https://www.googleapis.com/auth/contacts.readonly`
  - `openid`, `email`, `profile`
- Save. Project stays in **Testing** until you submit for verification.
- Add your own Google account (and any tester accounts) under **Test users** while in Testing — only those accounts can connect until verification is granted.

## 3. Create an OAuth client

- **APIs & Services → Credentials → Create Credentials → OAuth client ID**
- Application type: **Web application**
- Authorized redirect URIs — add one per environment:
  - `https://lumo-super-agent.vercel.app/api/connections/callback`
  - `http://localhost:3000/api/connections/callback`
- Save. You'll get a **Client ID** and **Client Secret**.

## 4. Set the env vars

In Vercel (Project → Settings → Environment Variables) and in your local `.env.local`:

```
LUMO_GOOGLE_CLIENT_ID=<client id>
LUMO_GOOGLE_CLIENT_SECRET=<client secret>
```

Targets: Production + Preview (and Development for local). Mark them sensitive.

## 5. Test the loop

1. Sign into Lumo.
2. `/marketplace` → "Google (Gmail · Calendar · Contacts)" card appears.
3. Click Connect → Google consent screen (expect to see all three scopes grouped).
4. Approve → you land back on `/connections` with an active row for `google`.
5. Ask Lumo "what's on my calendar tomorrow?" — Claude should call `calendar_list_events` and return what it found.

## 6. Privacy posture

What Lumo stores:
- `agent_connections`: your encrypted OAuth access/refresh tokens (so you don't reconnect every time).
- `events`: the metadata (tool name, latency, ok/fail) of each call, NOT the payload.

What Lumo does NOT store:
- Gmail message bodies, subjects, or senders. Every search/read fetches fresh from Google and passes through to Claude in-memory.
- Contact details. Every lookup fetches fresh.
- Calendar event content beyond what you explicitly asked Lumo to create.

When you disconnect in `/connections`, Lumo:
- Marks the connection row revoked (tokens destroyed at next rotation).
- Best-effort calls Google's revocation endpoint so any lingering token is invalidated.

You can also revoke any time at https://myaccount.google.com/permissions.

## 7. Add more scopes later

When we add `gmail_send`, we'll bump to `gmail.modify` or `gmail.send` and force a re-consent. Silent scope-escalation is not a thing here — Lumo asks Google to re-prompt the user explicitly.

## Troubleshooting

- **"redirect_uri_mismatch"** — the URI you set in the Cloud Console must exactly match what Lumo sends. Check trailing slashes and protocol.
- **"invalid_scope"** — you enabled the API but didn't add the scope under OAuth consent screen. Add it, save, and wait ~1 minute.
- **Works in dev, fails in prod** — set env vars on Vercel too; dev `.env.local` doesn't propagate.
- **"access_blocked"** — you're still in Testing mode and the Google account trying to connect isn't in Test users. Add it, or submit for verification.
