# Voice stack

How Lumo hears you, speaks back, knows when to stop, and (when wake-word ships) optionally activates on command. User-facing guide is at [users/voice-mode.md](../users/voice-mode.md); this is the "what's behind the button" version.

> **History note:** Lumo previously used ElevenLabs for TTS and the browser's native `SpeechRecognition` for STT. As of May 2026, both paths migrated to Deepgram (Aura-2 for TTS, Nova-3 for STT). ElevenLabs code paths remain as a 7-day fallback gated behind `LUMO_TTS_PROVIDER=elevenlabs`; cleanup lane `DEEPGRAM-CLEANUP-1` removes them after the rollback window closes. The ElevenLabs-era doc lives in git history at the commit prior to `DEEPGRAM-MIGRATION-1`.

## The pipeline (Deepgram era)

```
User speaks
   │
   ▼
[Deepgram Nova-3 STT (web: WSS streaming) ]
[Deepgram Nova-3 STT (iOS: WSS streaming) ]
   │   final transcript (with interim updates)
   ▼
[VoiceMode.tsx state machine on web]
[VoiceComposerViewModel state machine on iOS]
   │   user_message → orchestrator
   ▼
[POST /api/chat]   (orchestrator, same path as typed input)
   │   streaming SSE response text
   ▼
[Sentence-boundary chunker accumulates spokenText]
   │
   ▼
[POST /api/tts] (web)             [WSS /v1/speak] (iOS)
   │   ↓
   │   Deepgram Aura-2 streaming MP3 (web) / PCM (iOS)
   ▼
[Continuous MediaSource SourceBuffer (web)]
[Persistent AVAudioPlayerNode (iOS)]
   │   one playback session across N sentence chunks
   ▼
Audio in user's ears
   │
   ▼
[STT-gating state machine prevents barge-in during AGENT_SPEAKING + 300ms tail guard]
   │
   ▼
After tail guard: state → LISTENING
```

## Components and files

### Web (`apps/web/`)

- **`components/VoiceMode.tsx`** — State machine. Owns mic, TTS trigger, STT-gating phase transitions.
- **`lib/voice-mode-stt-gating.ts`** — Pure helper for phase gating (LISTENING / AGENT_THINKING / AGENT_SPEAKING / POST_SPEAKING_GUARD) and tail-guard parsing. Tested independently of UI.
- **`lib/streaming-audio.ts`** — Continuous multi-chunk MediaSource player. Each `/api/tts` response appends to a single `SourceBuffer`; `endOfStream()` deferred until last-chunk flag.
- **`lib/deepgram-tts-retry.ts`** — Server-side retry wrapper for Deepgram REST Speak. 3 attempts, fresh `AbortController` per attempt, 200ms backoff. Returns structured `tts_upstream_unavailable` 503 only after all attempts fail.
- **`lib/deepgram.ts`** — Shared Deepgram config: voice catalog, speed parameter (`LUMO_DEEPGRAM_TTS_SPEED`, default 0.9, range 0.7-1.5).
- **`lib/voice-catalog.ts`** — Aura-2 voice catalog (Thalia, Orpheus). Mirrored verbatim by iOS to keep the contract consistent across surfaces.
- **`app/api/tts/route.ts`** — Server proxy to Deepgram REST Speak streaming MP3. Server-side `LUMO_DEEPGRAM_API_KEY`. Speed appended as `?speed=N` query param.
- **`app/api/audio/deepgram-token/route.ts`** — iOS-facing token mint endpoint. Auth-gated, rate-limited (30 req/min/user). Calls Deepgram's `POST /v1/auth/grant` for a 60s `usage:write` JWT. Returns `{ token, expires_at }`. Long-lived API key never leaves the server.

### iOS (`apps/ios/Lumo/`)

- **`Services/DeepgramTokenService.swift`** — In-memory token cache with idle-gated refresh (`markStreamActive(_:)`). 7 typed error cases. Refresh-ahead at 50s elapsed, retry-once on 401 expiry.
- **`Services/SpeechRecognitionService.swift`** — Deepgram Nova-3 streaming via `URLSessionWebSocketTask`. SFSpeechRecognizer fully removed. Frame parser emits two messages per `speech_final` (interim + final).
- **`Services/TextToSpeechService.swift`** — Deepgram Aura-2 streaming via WSS `/v1/speak`. `DeepgramTTSSession` keeps one `AVAudioEngine` + `AVAudioPlayerNode` alive across multi-sentence replies (iOS analog of web's continuous-MediaSource pattern).
- **`Services/SpeechModeGating.swift`** — Pure phase-gating module mirroring web's `voice-mode-stt-gating.ts`. `VoiceModeMachinePhase` raw values byte-identical to web's string union for cross-platform telemetry parity.
- **`Components/ChatComposerTrailingButton.swift`** — Mic ↔ Send ↔ Stop swap. `Mode.from(input:isListening:phase:)` — phase has highest precedence. Stop affordance during `AGENT_SPEAKING` + `POST_SPEAKING_GUARD` provides explicit barge-in tap target.
- **`ViewModels/VoiceComposerViewModel.swift`** — State machine. `requestBargeIn()` calls `tts.cancel()` → state clears to `.listening`.
- **Build-time config:** `LumoVoiceTTSTailGuardMs` Info.plist key (default 300, clamp [0, 2000]).

## Speech-to-text (STT)

Both web and iOS use **Deepgram Nova-3 streaming** via WebSocket. Reasons for the migration off browser SpeechRecognition (web) and SFSpeechRecognizer (iOS):

- **Cross-platform parity** — same engine, same accuracy, same language coverage. No more "works on Chrome, fails on Firefox."
- **Better accuracy on accented English and noisy environments** vs the browser API's vendor-specific model.
- **Built-in speaker diarization** available (not yet activated; see `SPEAKER-DIARIZATION-PYTHON-1` follow-up).
- **Tone analysis hook** for future emotion detection (see `TONE-ANALYSIS-PYTHON-1`).

### WSS parameters

```
sample_rate=16000
encoding=linear16
smart_format=true
interim_results=true
endpointing=300
```

### Token plumbing (iOS)

Web speaks to Deepgram from server (`/api/tts` proxies). iOS can't (App Store would reject embedding a long-lived API key in the bundle). The token endpoint at `/api/audio/deepgram-token` mints 60s JWTs scoped to `usage:write` only. iOS refreshes at 50s elapsed; long-lived key stays server-side.

## Streaming TTS

### Web: REST Speak streaming MP3

`POST /api/tts` with `{ text, voice_id, emotion }` returns `audio/mpeg` chunked. Reasoning: browser MSE handles MP3 cleanly via `addSourceBuffer("audio/mpeg")`. WSS Speak streams PCM which would require manual decoding — not worth the complexity gain for browser playback.

### iOS: WSS Speak streaming PCM

iOS uses WSS `/v1/speak` because `AVAudioEngine` handles continuous PCM natively without decoding overhead. The `DeepgramTTSSession` keeps one player node alive across all sentence chunks for a multi-sentence reply, avoiding the per-chunk audio-element teardown that caused early truncation bugs on web.

### Default voice

`aura-2-thalia-en` (warm female). Second option `aura-2-orpheus-en` (calm male). Voice catalog mirrored verbatim across web + iOS.

### Speed

`LUMO_DEEPGRAM_TTS_SPEED` env var (default `0.9`, range `0.7–1.5` per Deepgram docs). 0.9 is the comfortable listening pace; 1.0 is Deepgram default; 0.85 was tested but felt slightly underpaced for chat replies.

### Multi-chunk pipeline (the bug we hunted)

The TTSChunker splits a streaming chat response on sentence boundaries and emits each chunk to `/api/tts` as a separate request. Early implementations called `endOfStream()` on the SourceBuffer after chunk 1 finished playing, sealing the buffer before chunk N+1 could append. Fix: defer `endOfStream()` until the last-chunk flag is set AND the queue is empty. Same principle on iOS (don't tear down the player node between chunks).

Regression tests in `apps/web/tests/deepgram-web-audio-hotfix.test.mjs` lock this behavior — five sequential mock blobs must all `appendBuffer` before `endOfStream()` is called.

## STT-gating (the second bug we hunted)

Pre-fix behavior: while the agent was speaking, STT was still listening passively. The agent's own TTS audio (or ambient noise) tripped a "user is speaking" event, the state machine cancelled remaining TTS to listen, and sentence N+1 was never sent to TTS. User experience: replies cut off mid-thought.

Fix: state machine gates STT input feed during `AGENT_SPEAKING` + `POST_SPEAKING_GUARD`. Mic input audio frames are NOT fed to Deepgram STT WSS during these phases. Resume after a 300ms tail guard (configurable via `LUMO_VOICE_TTS_TAIL_GUARD_MS`). User can still explicit-barge-in via the Stop button.

iOS mirrors the same pattern: `SpeechModeGating.isMicPaused(phase:)` returns true during gated phases; the underlying `SpeechRecognitionService` never starts during these phases.

## Server-side retry

Deepgram occasionally returns transient 5xx (cold-start tail latency, network blip). The route handler retries 3 times with fresh `AbortController` per attempt + 200ms backoff before bubbling a structured `503 tts_upstream_unavailable` to the client. Client-side: 503 surfaces a transient toast "Voice unavailable — chat continues" rather than failing the turn.

## Telemetry

Every `/api/tts` call logs structured Vercel function logs:

```json
{
  "event": "tts_deepgram_attempt",
  "attempt_number": 1 | 2 | 3,
  "status": <deepgram_response_status>,
  "deepgram_request_id": "<dg-request-id header>",
  "deepgram_response_body_preview": "<first 300 chars on non-2xx>",
  "elapsed_ms": <ms>,
  "text_length": <n>,
  "voice_id": "aura-2-thalia-en",
  "emotion": "warm"
}
```

Plus shadow telemetry to migration-058's `voice_provider_compare` table (provider, direction, latency_first_token_ms, total_audio_ms, audio_bytes, error). Used for cutover decisions when ElevenLabs cleanup lane fires.

Headers on `/api/tts` responses:
- `x-lumo-tts-provider: deepgram`
- `x-lumo-tts-emotion: warm`
- `x-vercel-id: <region>::<region>::<id>` (for log lookup)

## Wake word (in design)

`docs/designs/voice-mode-wake-word.md` (lane `VOICE-MODE-WAKE-WORD-1`) covers the architecture. Recommendation: Picovoice Porcupine for v1/demo (paid SDK, fast on-device detection), OpenWakeWord as open fallback. Deepgram STT only activates AFTER wake-word fires — never as the idle wake gate. Implementation lane fires after the immediate STT-gating + chunked-player + speed fixes are stable in production.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Silent voice, `/api/tts` returns 5xx repeatedly | Deepgram outage or invalid `LUMO_DEEPGRAM_API_KEY` | Check Vercel env vars; confirm key is valid via Deepgram console |
| Voice cuts off mid-sentence on multi-sentence replies | STT-gating regression (state machine doesn't gate during AGENT_SPEAKING) | Should be fixed; if recurs, check `voice-mode-stt-gating.ts` test suite |
| Last sentence of reply is silent | Chunker's `[DONE]` signal arrives before chunker emits trailing sentence | Should be fixed; if recurs, check chunker drain-on-done logic |
| Speech feels too fast | `LUMO_DEEPGRAM_TTS_SPEED` not set or set above 0.9 | Set to `0.9` on Vercel; redeploy not strictly required (read at request time) |
| iOS bundle rejected by App Store with "embedded API key" warning | `LUMO_DEEPGRAM_API_KEY` accidentally added to xcconfig | Use `/api/audio/deepgram-token` endpoint; key MUST stay server-side |
| Barge-in button disappears during agent speech | Trailing button conditional render doesn't cover `AGENT_SPEAKING` phase | Should be fixed; if recurs, check `ChatComposerTrailingButton.Mode.from(input:isListening:phase:)` |

## Related

- [users/voice-mode.md](../users/voice-mode.md) — user-facing guide (needs update for Aura-2 voice names).
- [orchestration.md](orchestration.md) — voice input/output goes through the same orchestrator as typed messages.
- [operators/env-vars.md](../operators/env-vars.md) — `LUMO_DEEPGRAM_API_KEY`, `LUMO_TTS_PROVIDER`, `LUMO_DEEPGRAM_TTS_SPEED`, `LUMO_VOICE_TTS_TAIL_GUARD_MS`.
- [docs/designs/voice-mode-wake-word.md](../designs/voice-mode-wake-word.md) — wake-word implementation design.
- [docs/contracts/deepgram-token.md](../contracts/deepgram-token.md) — iOS token mint contract.
- [docs/contracts/ios-deepgram-integration.md](../contracts/ios-deepgram-integration.md) — full iOS Deepgram integration spec.
- [docs/doctrines/mic-vs-send-button.md](../doctrines/mic-vs-send-button.md) — composer button mode-pick rule.
- [docs/doctrines/selection-card-confirmation.md](../doctrines/selection-card-confirmation.md) — 280ms confirmation pattern.
