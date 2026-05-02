# DEEPGRAM-IOS-IMPL-1 — recon, 2026-05-02

Branch: `claude-code/ios-deepgram-impl-1` (recon-only commit; scope
work waits for codex's `codex/deepgram-migration-1` branch to merge
to `origin/main`).

## Precondition status

| Item | State |
|---|---|
| `docs/contracts/ios-deepgram-integration.md` exists | ✓ on `codex/deepgram-migration-1` (commit `60b70d8`) |
| `docs/contracts/deepgram-token.md` exists | ✓ on `codex/deepgram-migration-1` (commit `60b70d8`) |
| Both tagged `contract-frozen` | ✓ — both files start with `Status: contract-frozen`; commit subject is `docs(audio): freeze deepgram ios contract` |
| Files on `origin/main` | ✗ NOT YET — codex's branch unmerged |

**Implication:** scope work cannot start until codex's branch lands
on main. This commit is recon-only per the brief's `RECON (allowed
before contract-frozen)` clause.

## Existing voice substrate (to be replaced)

### TTS path — ElevenLabs Turbo

Primary entry point: `apps/ios/Lumo/Services/TextToSpeechService.swift`
(347 lines).

| File | Role |
|---|---|
| `Services/TextToSpeechService.swift` | `TextToSpeechServicing` protocol + `TextToSpeechService` class. Two-tier fallback chain: ElevenLabs Turbo (WebSocket) → AVSpeechSynthesizer. State machine: `idle / speaking(provider) / finished(provider) / fallback(from:to:reason) / error`. Streams via `beginStreaming() / appendToken(_:) / finishStreaming()` for LLM-token-by-token TTS, plus `speak(_:)` for completed messages. `cancel()` halts in-flight playback. |
| `Services/TTSChunker.swift` | Pure helper that buffers LLM tokens and emits speakable phrase chunks at sentence boundaries (so ElevenLabs sees natural prosody breaks). 139 lines. **Reusable for Deepgram Aura-2** — chunking strategy is provider-agnostic. |
| `Services/AppConfig.swift` | Reads `LUMO_ELEVENLABS_API_KEY` and `LUMO_ELEVENLABS_VOICE_ID` from xcconfig substitution. `isElevenLabsConfigured` flag drives the fallback decision. |
| `Lumo.xcconfig` | Declares `LUMO_ELEVENLABS_API_KEY` + `LUMO_ELEVENLABS_VOICE_ID` (sourced from `~/.config/lumo/.env`). |
| `Resources/Info.plist` | Carries the two ElevenLabs xcconfig keys. |
| `project.yml` | Surfaces the same in `INFOPLIST_KEY_*` settings. |

Internal mechanics:

- `elevenLabsTask: URLSessionWebSocketTask?` — the WebSocket held strong while in flight.
- `elevenLabsURLSession: URLSession?` — paired session.
- Auth header: `xi-api-key: <LUMO_ELEVENLABS_API_KEY>` (line 200) — long-lived API key in the iOS bundle. **This is exactly the anti-pattern the Deepgram contract eliminates.**
- AVSpeechSynthesizer fallback always available.

LumoApp wires the service via `TextToSpeechService(config: config)`
and passes through to `RootView`/`ChatViewModel`.

### STT path — SFSpeechRecognizer + AVAudioEngine

Primary entry point:
`apps/ios/Lumo/Services/SpeechRecognitionService.swift` (305 lines).

| File | Role |
|---|---|
| `Services/SpeechRecognitionService.swift` | `SpeechRecognitionServicing` protocol + `SpeechRecognitionService` class. Wraps SFSpeechRecognizer + AVAudioEngine; emits partial transcripts via `state = .listening(partial:)` and final via `state = .final(transcript:)`. Auto-stops on 1.5s silence. |
| `Services/AudioSessionManager.swift` | 56-line helper that configures `AVAudioSession` for record + playback. **Reusable** — the audio session itself is provider-agnostic; Deepgram needs the same configuration. |
| `ViewModels/VoiceComposerViewModel.swift` | 196-line state machine: `idle / requestingPermissions / permissionDenied / listening / ready / error`. Holds a `SpeechRecognitionServicing` (protocol-fronted, so the swap is straightforward). Methods `tapToTalk()`, `pressBegan()`, `release()`, `consumeReadyTranscript()`. |

Internal mechanics:

- `audioEngine: AVAudioEngine?` — the input-tap source.
- `recognitionTask: SFSpeechRecognitionTask?` — Apple's recognizer (line 82).
- `silenceTimer: Task<Void, Never>?` — auto-stop guard.
- All callbacks hop to `@MainActor` before mutating state.

### Voice settings

`apps/ios/Lumo/Services/VoiceSettings.swift` (38 lines) —
UserDefaults wrapper:

- `speakResponses: Bool` (key `lumo.voice.speakResponses`, default
  true on first launch).
- `hasUsedVoice: Bool` (read-only flag set by
  `VoiceComposerViewModel.consumeReadyTranscript()`).

**No voice-id storage today.** The brief requires Settings to grow
a Thalia ↔ Orpheus picker — that's net-new state + UI. Web's
canonical key is `voice.voice_id`; iOS should mirror with
`lumo.voice.voiceId` UserDefault.

### Settings UI

`apps/ios/Lumo/Views/SettingsView.swift` already shows a
"speakResponses" toggle gated behind `hasUsedVoice` (line 190).
The Thalia ↔ Orpheus picker plugs into the same conditional
section.

### Tests

| File | Coverage |
|---|---|
| `LumoTests/VoiceStateMachineTests.swift` | 219 lines. Drives `SpeechRecognitionServicing` + `VoiceComposerViewModel` via `FakeSpeechRecognitionService`. Will need updating to drive `FakeDeepgramSTTClient` once SFSpeech is removed. |
| `LumoTests/TTSChunkingTests.swift` | 128 lines. Covers `TTSChunker` only (provider-agnostic). **Should survive intact** since Deepgram Aura-2 uses the same chunking strategy. |

## PTT mode-pick rule integration

`apps/ios/Lumo/Components/ChatComposerTrailingButton.swift::Mode.from(input:isListening:)`
already implements the listening-wins-over-input rule per
`docs/doctrines/mic-vs-send-button.md` (Lane 3). The contract:

```swift
static func from(input: String, isListening: Bool) -> Mode {
    if isListening { return .waveform }
    if input.trimmingCharacters(in: .whitespaces).isEmpty { return .mic }
    return .send
}
```

The `isListening` source is `voiceComposer.state.isListening`,
which flips when the underlying recognition service emits
`.listening`. **As long as the Deepgram STT client surfaces an
equivalent state to VoiceComposerViewModel, the mode-pick rule
needs zero changes.** That's the right abstraction boundary for
the swap.

## Voice catalog (web canonical)

From `codex/deepgram-migration-1:apps/web/lib/voice-catalog.ts`:

```typescript
export const VOICE_CATALOG: VoiceOption[] = [
    { id: "aura-2-thalia-en", ... },
    { id: "aura-2-orpheus-en", ... },
];
export const DEFAULT_VOICE_ID = ...;
```

Default = `aura-2-thalia-en`. iOS Settings picker should expose
both with the same IDs so a user-level voice preference (when
that lands per IOS-DEEPGRAM-PERSONALIZATION-1) syncs cleanly across
platforms.

## Token endpoint contract (codex's `deepgram-token.md`)

- Endpoint: `POST /api/audio/deepgram-token` (Supabase session cookie auth).
- Response: `{ token, expires_at }` — JWT + ISO 8601 fractional UTC.
- TTL: 60 seconds. Refresh at 50s elapsed or on provider 401.
- Rate limit: 30 grants per user/IP per 60s. Over → 429 with `retry_after_seconds`.
- Errors: `401 not_authenticated` → relogin flow; `403 forbidden`; `429 rate_limited`; `503 deepgram_not_configured`; `502 deepgram_token_error`.
- **Memory-only on client.** No Keychain, no logs, no crash report.

## Streaming contracts (codex's `ios-deepgram-integration.md`)

### STT — wss://api.deepgram.com/v1/listen

Query params (frozen):

```
model=nova-3
smart_format=true
interim_results=true
endpointing=300
encoding=linear16
sample_rate=16000
channels=1
```

Audio: 16 kHz mono linear16 PCM frames, fed in real time.
Auth: `Authorization: Bearer <temporary token>`.
Output: JSON frames; render `is_final=false` interim, append
`is_final=true` final, end-of-turn on `speech_final=true` ANDed
with local silence/debounce agreement.

### TTS — wss://api.deepgram.com/v1/speak

Query params (frozen):

```
model=aura-2-thalia-en   (or aura-2-orpheus-en)
encoding=linear16
sample_rate=48000
```

Output: chunked linear16 PCM. Feed into AVAudioEngine + AVAudioPlayerNode
on first chunk arrival; do not wait for stream close. Halt on:
mute, barge-in, route change, push-to-talk start.

### Reconnect / error policy

- Network drop: silent retry with exponential backoff, ≤3 attempts
  per turn. Refresh token if older than 50s or close indicates
  auth expiry. After 3 failures → user-visible toast + fall back
  to text mode for the turn.
- Provider auth error: re-fetch token, retry once, surface toast on
  second failure.

## Implementation plan (post-contract-merge)

When `origin/main` carries codex's contract, the lane's scope work
can land in this commit shape:

| Commit | Files |
|---|---|
| 1. `feat(ios): DeepgramTokenService` | New `Services/DeepgramTokenService.swift` (memory-only cache + refresh-ahead at 50s + 401 retry-once + 429 honor `retry_after_seconds`). New `LumoTests/DeepgramTokenServiceTests.swift`. |
| 2. `feat(ios): Deepgram STT (Nova-3 streaming)` | New `Services/DeepgramSTTClient.swift` (URLSessionWebSocketTask → wss `/v1/listen` with frozen params, AVAudioEngine input-tap → 16kHz linear16 frames). Replace `SpeechRecognitionService.swift` with a thin protocol-conformant wrapper, OR have `VoiceComposerViewModel` directly hold a `DeepgramSTTClient` (decision waits on contract read). Update `VoiceStateMachineTests.swift` for the new fake. |
| 3. `feat(ios): Deepgram TTS (Aura-2 playback)` | New `Services/DeepgramTTSClient.swift` (URLSessionWebSocketTask → wss `/v1/speak`, chunked linear16 → `AVAudioPlayerNode`). Rewire `TextToSpeechService.swift` to use Deepgram instead of ElevenLabs (preserve `TextToSpeechServicing` protocol so the rest of the app is unchanged). `TTSChunker` survives unchanged. |
| 4. `feat(ios): voice picker — Thalia ↔ Orpheus` | `VoiceSettings.swift` grows `voiceId` UserDefault (default `aura-2-thalia-en`). `SettingsView` voice section grows a `Picker` + label. |
| 5. `chore(ios): purge ElevenLabs config + Info.plist keys` | Remove `LUMO_ELEVENLABS_*` from xcconfig + Info.plist + project.yml + AppConfig. Replace with `LUMO_DEEPGRAM_*` only as build-time gating values needed (per token contract, no `LUMO_DEEPGRAM_API_KEY` in the bundle — the server holds it). |
| 6. `docs(deepgram-ios-impl-1)` | Progress note + STATUS ready-for-review. |

Estimated test bundle delta: +20 to +30 (token service + STT
client integration + TTS client integration + voice-picker tests).
Target post-lane: 355–365.

## Risks / questions to surface before scope-work commit

1. **Audio session mode for full-duplex.** Current
   `AudioSessionManager` configures `playAndRecord` mode with
   `defaultToSpeaker`. Deepgram's TTS at 48 kHz playback while
   STT is at 16 kHz capture — verify the audio session can hold
   both rates without resampling artefacts. Possibly need
   `AVAudioSession.RouteSharingPolicy.longFormAudio` or similar.
2. **Token-refresh during in-flight streams.** Contract says
   refresh at 50s or on auth error. If a long-running STT
   stream's token expires mid-utterance, the contract implies the
   socket closes with auth code → reconnect. Confirm that
   reconnect mid-turn doesn't lose the partial transcript; may
   need a small in-memory buffer.
3. **Settings picker lifecycle.** Web's voice ID lives in
   `voice.voice_id` admin-setting. iOS user-level picker writes
   to UserDefaults; if cross-device sync is desired (matching
   web), file `IOS-VOICE-PICKER-SYNC-1` deferred — out of scope
   for this lane.

These three are recon-flagged as known unknowns to confirm during
implementation rather than blockers.

## Source pointers

Existing iOS voice substrate (to be removed/repointed):

- `apps/ios/Lumo/Services/TextToSpeechService.swift`
- `apps/ios/Lumo/Services/SpeechRecognitionService.swift`
- `apps/ios/Lumo/Services/TTSChunker.swift` *(reusable)*
- `apps/ios/Lumo/Services/AudioSessionManager.swift` *(reusable)*
- `apps/ios/Lumo/Services/VoiceSettings.swift`
- `apps/ios/Lumo/Services/AppConfig.swift`
- `apps/ios/Lumo/ViewModels/VoiceComposerViewModel.swift`
- `apps/ios/Lumo/Views/SettingsView.swift` (Speak responses toggle + voice section)
- `apps/ios/Lumo/Components/ChatComposerTrailingButton.swift` *(unchanged; mode-pick rule survives the swap)*
- `apps/ios/Lumo.xcconfig` + `apps/ios/Lumo/Resources/Info.plist` + `apps/ios/project.yml`
- `apps/ios/LumoTests/VoiceStateMachineTests.swift`
- `apps/ios/LumoTests/TTSChunkingTests.swift` *(survives; chunking is provider-agnostic)*

Codex's frozen contract:

- `docs/contracts/ios-deepgram-integration.md` (on
  `codex/deepgram-migration-1` at `60b70d8`).
- `docs/contracts/deepgram-token.md` (same commit).
