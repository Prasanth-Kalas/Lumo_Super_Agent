# OAuth app setup guides

Per-provider instructions for registering an OAuth app that pairs with your Lumo deployment. Each guide covers:

- Where to register the app at the provider.
- Which redirect URIs to add (pointing at your Lumo deployment).
- Which scopes to request.
- Which env vars to set on Lumo.
- How to test the end-to-end connection.

## Guides

- **[Google](google.md)** — Gmail, Calendar, Contacts via Google Cloud Console.
- **[Microsoft](microsoft.md)** — Outlook, Calendar, Contacts via Azure Entra ID.
- **[Spotify](spotify.md)** — Web API access via Spotify Developer Dashboard. Note the Premium requirement.

## Common gotchas (regardless of provider)

1. **Redirect URI must match exactly.** Including `https` vs `http`, trailing slash, subdomain. Any mismatch → `redirect_uri_mismatch` error.
2. **Client secret vs client ID.** Every provider has both. The env var `LUMO_*_CLIENT_SECRET` expects the **secret value**, not the secret ID (Azure in particular shows both and they look similar).
3. **Dev vs prod apps.** Register separate OAuth apps for each environment. Dev app has `http://localhost:3000/api/connections/callback` allowed; prod app has your production URL.
4. **Sensitive scopes may require verification.** For Google, the restricted-scope apps require a verification process. For Microsoft work-tenant users, admin consent may be needed. Both guides cover specifics.
5. **Rotation.** Client secrets should be rotated annually. Rotation = generate new secret in provider, update Vercel env, redeploy, revoke old secret. Small window where in-flight requests may 401.

## Adding a new provider

If you want a provider not listed here (Notion, Slack, Stripe Connect, etc.):

1. Build the agent (see [../../developers/oauth-integration.md](../../developers/oauth-integration.md)).
2. Register a provider OAuth app the usual way, with redirect URI `https://<your-deployment>/api/connections/callback`.
3. Set `LUMO_<PROVIDER>_CLIENT_ID` and `LUMO_<PROVIDER>_CLIENT_SECRET` in Vercel env (the exact names come from your manifest's `client_id_env` / `client_secret_env` fields).
4. Register the agent in the Super Agent's `lib/agent-registry.ts`.

Contribute the setup guide back to `docs/operators/oauth-apps/<provider>.md` so the next operator doesn't start from scratch.
