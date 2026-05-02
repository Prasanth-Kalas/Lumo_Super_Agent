# iOS Deepgram Integration Contract

Status: contract-frozen

Owner: Codex owns this server contract. Claude Code implements Swift against it.

## Token Fetch

Before opening any Deepgram realtime WebSocket, iOS calls:

```http
POST /api/audio/deepgram-token
cookie: <Supabase session>
```

Response:

```json
{ "token": "<temporary Deepgram JWT>", "expires_at": "2026-05-02T12:00:00.000Z" }
```

Refresh strategy:

- Fetch a fresh token before the first voice turn.
- Refresh at 50 seconds after issue time, even if `expires_at` is still a few seconds away.
- Refresh immediately if Deepgram returns an expiry/auth error.
- Keep the token in memory only.

Reference: the endpoint details and error schema are frozen in `docs/contracts/deepgram-token.md`.

## STT: Nova-3 Streaming

Endpoint:

```text
wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=true&endpointing=300&encoding=linear16&sample_rate=16000&channels=1
```

Authentication:

```http
Authorization: Bearer <temporary token from /api/audio/deepgram-token>
```

Audio contract:

- Sample rate: `16000`
- Encoding: `linear16`
- Channels: `1`
- Push-to-talk rule is unchanged: listening always wins over text input. If the mic is actively listening, the composer trailing affordance stays in listen/send-stop posture rather than switching to text submit.

Transcript handling:

- Render interim transcripts while `is_final=false`.
- Append finalized text when `is_final=true`.
- Treat `speech_final=true` as the end-of-turn boundary after the existing local silence/debounce rules agree.
- `smart_format=true` is part of the contract, so client display text can preserve Deepgram formatting.

## TTS: Aura-2 Playback

Default voice: `aura-2-thalia-en`

Secondary option: `aura-2-orpheus-en`

Server `/api/tts` remains the web proxy for browser playback. iOS realtime playback may use Deepgram Speak directly with the short-lived token:

```text
wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=48000
```

Authentication:

```http
Authorization: Bearer <temporary token from /api/audio/deepgram-token>
```

Playback contract:

- Deepgram emits chunked `linear16` PCM.
- Expected chunks are variable-sized binary frames. iOS should enqueue any non-empty frame immediately rather than waiting for a preferred packet size.
- Feed chunks into `AVAudioEngine` / `AVAudioPlayerNode` as they arrive.
- Start playback on first valid audio chunk; do not wait for stream close.
- End of stream is the WebSocket close after a `Close` command or provider normal-close event once all queued audio has drained.
- Stop playback immediately on mute, barge-in, route change, or push-to-talk start.

## Error And Reconnect

Network drop:

- Reconnect silently with exponential backoff: 250ms, 500ms, 1000ms.
- Try up to 3 reconnects for the current turn.
- Refresh the token before retry if the token is older than 50 seconds or the close reason indicates auth expiry.
- After 3 failures, show a user-visible toast and fall back to text mode for the turn.

Provider auth error:

- Fetch a new token once and retry.
- If the retry fails, show the same user-visible toast.

Server token errors:

- `401`: session expired; use the app's sign-in/session-refresh flow.
- `429`: wait for `retry_after_seconds`.
- `503`: voice unavailable; keep text mode working.

## Push-To-Talk Doctrine

The mode-pick rule is unchanged from `docs/doctrines/mic-vs-send-button.md`: listening always wins over text input. If STT is active, the composer affordance remains in the listen/send-stop state even when text is present.

## Privacy Rules

- Do not embed `LUMO_DEEPGRAM_API_KEY` in the iOS bundle.
- Do not log temporary tokens, raw audio chunks, full transcripts, or provider response bodies.
- Crash reports may include only bounded machine-readable error codes.
