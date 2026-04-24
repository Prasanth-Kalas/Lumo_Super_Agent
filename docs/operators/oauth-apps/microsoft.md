# Microsoft 365 integration — Outlook · Calendar · Contacts

Single Azure AD app registration → three integrations. Same privacy posture as Google: read-heavy, tokens encrypted in `agent_connections`, nothing else persisted.

## 1. Register the app in Azure

1. Go to https://portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name it (e.g. "Lumo").
3. **Supported account types**: *Accounts in any organizational directory and personal Microsoft accounts* (multi-tenant). This is what lets both `@outlook.com` and work Microsoft 365 accounts connect with the same app.
4. **Redirect URI** → platform **Web** → `https://<your-deployment>/api/connections/callback` (and add `http://localhost:3000/api/connections/callback` for dev).
5. Click Register. You'll land on the overview — note the **Application (client) ID**.

## 2. Client secret

- **Certificates & secrets** → **+ New client secret** → description "Lumo" → expiration your choice (24 months is fine).
- Copy the **Value** immediately (Azure only shows it once).

## 3. API permissions

- **API permissions** → **+ Add a permission** → **Microsoft Graph** → **Delegated permissions**.
- Add each of:
  - `openid`
  - `profile`
  - `email`
  - `offline_access` ← **critical** — without this Lumo loses access every hour
  - `User.Read`
  - `Mail.Read`
  - `Calendars.ReadWrite`
  - `Contacts.Read`
- For personal Microsoft accounts, no admin-consent needed.
- For work/school accounts, the tenant's admin may need to grant consent depending on org policy. Users will see an "Approval required" screen if so.

## 4. Env vars

```
LUMO_MICROSOFT_CLIENT_ID=<application (client) id>
LUMO_MICROSOFT_CLIENT_SECRET=<the secret value>
```

Set in Vercel Project Settings → Environment Variables (sensitive, targets: production + preview). Also in `.env.local` for dev.

## 5. Test

1. Sign into Lumo.
2. `/marketplace` → "Microsoft 365 (Outlook · Calendar · Contacts)" card appears.
3. Connect → Microsoft consent screen → Accept.
4. Ask Lumo "did anyone email me about the quarterly review today?"
5. Ask Lumo "block 2-3pm Thursday for a call with alex@example.com" — you should see a confirmation card, then the event lands on your calendar after you confirm.

## Privacy

Same as Google:
- Tokens (encrypted) persist in `agent_connections`.
- Outlook messages, contacts, and calendar body content are fetched on demand and never written to Lumo's DB.
- Calendar events you ask Lumo to create are written to Outlook directly; Lumo keeps no copy.

## Troubleshooting

- **"AADSTS50011: Reply URL mismatch"** — the redirect URI in Azure must exactly match what Lumo sends. Check trailing slashes and `https` vs `http`.
- **"invalid_scope"** — you didn't add one of the permissions above. Go back to **API permissions** and re-add.
- **Works on personal MS account, fails on work account** — your tenant admin hasn't granted consent. Either request it, or switch the Azure app's supported account types to personal-only.
- **Refresh fails after an hour** — `offline_access` was missing at consent time. Disconnect in `/connections`, add the scope in Azure, reconnect.
