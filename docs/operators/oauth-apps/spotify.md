# Spotify integration

Single OAuth app. Read-heavy for Free accounts; playback control requires the end user to have **Spotify Premium**.

## 1. Create a Spotify app

1. Go to https://developer.spotify.com/dashboard → log in with any Spotify account.
2. **Create app**.
   - Name: "Lumo" (user-visible on the consent screen).
   - Description: e.g. "Concierge assistant that can search and control playback."
   - **Redirect URIs** — add both:
     - `https://<your-deployment>/api/connections/callback`
     - `http://localhost:3000/api/connections/callback`
   - Which APIs you plan to use: **Web API**.
3. Save. You'll see **Client ID**. Click **View client secret** to reveal **Client Secret**.

Spotify doesn't require app review for Web API usage below rate limits — you can ship once the redirect URIs match.

## 2. Env vars

```
LUMO_SPOTIFY_CLIENT_ID=<client id>
LUMO_SPOTIFY_CLIENT_SECRET=<client secret>
```

Set in Vercel + `.env.local`.

## 3. Test

1. Sign in to Lumo.
2. `/marketplace` → "Spotify" card appears.
3. Connect → Spotify consent screen → Agree.
4. **Open Spotify on a device** (phone, desktop app, web player). Playback endpoints only work when Spotify has an active device.
5. Ask Lumo "what's playing" — should return the current track.
6. With Premium: "play something chill" → Lumo searches + starts playback on your active device.
7. Without Premium: search + recently-played work; play/pause/queue return a user-visible "Spotify Premium required for playback control" error.

## Privacy

- Tokens (encrypted) persist in `agent_connections`.
- Listening history, playlists, and current playback state pass through to Claude on demand and are never written to Lumo's DB.

## Troubleshooting

- **"INVALID_CLIENT: Invalid redirect URI"** — URI mismatch. Must exactly match (including protocol and trailing slash).
- **"No active device"** on play/pause** — Spotify needs at least one device playing or recently active. Open the Spotify app on phone or desktop first.
- **403 on play/pause/queue** — end user doesn't have Premium. Not a Lumo config issue.
- **Rate limiting** — Spotify is generous but not infinite. For the low-volume tools we use, hitting it means a bug (infinite loop) more often than real user traffic.
