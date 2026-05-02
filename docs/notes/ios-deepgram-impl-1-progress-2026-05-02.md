# DEEPGRAM-IOS-IMPL-1 — partial progress, 2026-05-02

Branch: `claude-code/ios-deepgram-impl-1` (5 commits, branched from
`origin/main` at the IOS-DOCTRINE-DOCS-1 closeout).

**STATUS: partial — Phases 1-2 of 6 complete. Phases 3-6 pending.**

Lane brief sketched a 6-commit shape (token service → STT client →
TTS client → voice picker → ElevenLabs purge → closeout). This
push covers Phases 1-2 — the full replacement of SFSpeechRecognizer
STT with Deepgram Nova-3, plus the shared token-cache infrastructure.
Phase 3 (TTS replacement) onward needs a fresh review cycle to keep
the architecture diff reviewable in chunks.

## What landed (Phases 1-2)

### Phase 1 — DeepgramTokenService (commit `1c9e957`)

`apps/ios/Lumo/Services/DeepgramTokenService.swift` — memory-only
short-lived token cache:

- `currentToken() async throws -> String` — returns a token
  guaranteed-fresh for the next ~10 seconds; mints if needed.
- `invalidate()` — force re-mint on next call (used by 401
  reconnect path).
- `markStreamActive(_:)` — RISK 2 reviewer answer. Refresh-ahead
  suppresses itself while a stream is active; only fully-expired
  tokens trigger a mint mid-stream.
- 7 typed error cases mapping each documented endpoint failure
  (401 not_authenticated, 403 forbidden, 429 rate_limited with
  retryAfter from header OR body, 502 deepgramMintFailed,
  503 deepgramNotConfigured, transport, decode).
- URLSessionProtocol seam + FakeURLSession stub for tests.

12 new `DeepgramTokenServiceTests` covering: mint+cache, cache
reuse within freshness window, refresh-ahead at lead time,
invalidate(), stream-active gating per RISK 2, and the 6 typed
error mappings.

### Phase 2 — Deepgram Nova-3 STT (commit `0b2c402`)

`apps/ios/Lumo/Services/SpeechRecognitionService.swift` — internal
swap from Apple Speech to Deepgram Nova-3 streaming over WebSocket.

Protocol surface preserved exactly so VoiceComposerViewModel + the
chat composer's PTT mode-pick rule (mic-vs-send-button doctrine)
keep working unchanged. Class name retained for symbol stability;
future rename to `DeepgramSTTService` is a separate, mechanical PR.

Wire contract per `docs/contracts/ios-deepgram-integration.md`:

- WSS `wss://api.deepgram.com/v1/listen` with frozen query params
  (model=nova-3, smart_format=true, interim_results=true,
  endpointing=300, encoding=linear16, sample_rate=16000, channels=1).
- Authorization: Bearer <temporary token from DeepgramTokenService>.
- Audio frames: 16 kHz mono linear16 PCM via AVAudioEngine input
  tap → AVAudioConverter (resamples from native 44.1/48 kHz) →
  binary WS messages.
- Transcript frames: JSON; parser yields `.interim` / `.final` /
  `.speechFinal` messages. `speech_final=true` emits BOTH the
  chunk (caught by accumulator) AND the `.speechFinal` sentinel
  (drives stop/commit).

Reconnect / RISK 2 reviewer answer:

- Up to 3 retries per turn with 250 / 500 / 1000 ms backoff.
- Token refresh-ahead suppressed during in-flight stream
  (`markStreamActive(true)`).
- Mid-stream 401 surfaces "Reconnecting…" toast, loses the
  partial transcript, resumes on next utterance — acceptable
  per reviewer (rare; > 60s continuous mic-hold only).
- 401 retry path is fresh-WSS-handshake retry, not audio replay.
- After 3 failures → `state = .error`, caller falls back to text.

Audio session / RISK 1 reviewer answer:

- AudioSessionManager already on
  `AVAudioSession.Category.playAndRecord` + `mode = .voiceChat`.
- AVAudioEngine input node sample rate preferred at 16000 Hz;
  output node negotiates hardware rate (typically 48 kHz). Engine
  handles internal resampling via AVAudioMixerNode. Bluetooth-
  fallback path filed as **IOS-DEEPGRAM-BLUETOOTH-FALLBACK-1** if
  AirPods Pro surprises us.

Permission contract narrowed: only microphone access required.
SFSpeechRecognizer authorization gone. `.speechRecognitionDenied`
and `.restrictedByDevice` cases stay in the enum for protocol
stability with VoiceComposerViewModel but are unreachable.

DeepgramTokenService plumbed through LumoApp → AppRootView →
RootView so Phase 3 (TTS) shares the same memory-only token cache.
ChatView's unused convenience init removed.

9 new `DeepgramSTTFrameTests` pin the parser contract bucket-by-
bucket: interim, empty-interim-skipped, final, speech_final-emits-
both-chunk-and-sentinel, speech_final-with-empty-transcript,
metadata-only frames, malformed JSON, defensive missing-channel-
but-speech_final, and the streamURL frozen-params contract.

## Tests

`xcodebuild test -scheme Lumo -only-testing:LumoTests` →
**356 tests, 0 failures** (was 335 before the lane: +12 in
DeepgramTokenServiceTests, +9 in DeepgramSTTFrameTests). On track
for the brief's 355–365 target with the remaining Phase 3 frame
tests still to land.

## What's NOT done (Phases 3-6)

| Phase | Scope | State |
|---|---|---|
| 3 — Deepgram Aura-2 TTS | Replace ElevenLabs WebSocket + AVSpeechSynthesizer fallback in `TextToSpeechService.swift` with Deepgram `wss://api.deepgram.com/v1/speak`. AVAudioEngine + AVAudioPlayerNode for chunked linear16 PCM playback at 48 kHz. Halt on mute/barge-in/route-change/PTT-start. | Not started |
| 4 — Voice picker | Settings UI for Thalia ↔ Orpheus. `VoiceSettings.voiceId` UserDefault (default `aura-2-thalia-en`). | Not started |
| 5 — ElevenLabs purge | Remove `LUMO_ELEVENLABS_*` from AppConfig, xcconfig, Info.plist, project.yml, GoogleSignInTests. Drop `.elevenLabs` enum case. Remove AVSpeechSynthesizer fallback (per "Full Deepgram, no fallback" brief). | Not started |
| 6 — Closeout | Progress note (this doc) + STATUS ready-for-review. Manual end-to-end voice-mode smoke verification on iPhone 17 Sim. | Partial (this doc) |

## Acceptance gate status

| Gate | State |
|---|---|
| Zero ElevenLabs references in apps/ios/ | ✗ — Phase 5 |
| Zero SFSpeechRecognizer references in apps/ios/ | ✓ — Phase 2 deleted them |
| End-to-end voice mode on iPhone 17 Sim | ✗ — Phase 3 prerequisite |
| Token never visible in any logged URL/body | ✓ — DeepgramTokenService is memory-only, no logging |
| Reconnect logic verified via integration test | Partial — frame-level parser + 3-retry policy in Phase 2 source; integration test (mocked URLSessionWebSocketTask) deferred to Phase 3 |
| Settings voice picker functional (Thalia ↔ Orpheus) | ✗ — Phase 4 |
| Test bundle ≥ 350 | ✓ — 356 |
| Capture-script PNGs unchanged | ✓ — no UI surface changes Phase 1-2 |

## Why partial-push-for-review now

Two reasons:

1. The architectural decisions in Phase 1 (token service shape,
   stream-active gating, error-case taxonomy) and Phase 2
   (preserving SpeechRecognitionServicing protocol vs introducing
   a new STTServicing one; class name retained vs renamed; parser
   emitting two messages for speech_final) are non-obvious and
   benefit from a review checkpoint before Phase 3 builds on
   them. Phase 3 (TTS) reuses the token service and the audio-
   session config; if the reviewer wants those reshaped, doing
   it once and rebasing Phase 3 is cheaper than reshaping Phase
   3 later.

2. Phase 3 (TTS WebSocket + AVAudioPlayerNode + chunked binary
   playback) is genuinely the largest remaining piece. Bundling
   it with the smaller Phases 4-5-6 in one mega-commit would push
   the lane over its review-friendly diff size.

The partial doesn't FF-merge — per brief's "Post ready-for-review
when all gates pass; do not FF-merge unilaterally" rule.
Reviewer can either (a) approve the architecture and authorize
me to proceed with Phases 3-6 in a continuation, or (b) redirect
on Phases 1-2 and have me reshape before continuing.

## Out of scope (deferred)

- **IOS-DEEPGRAM-OFFLINE-1** — offline detection + queue.
- **IOS-DEEPGRAM-PERSONALIZATION-1** — per-user voice preference learning.
- **IOS-DEEPGRAM-MULTILINGUAL-1** — language detection.
- **IOS-VOICE-MODE-VISUAL-REFRESH-1** — visual changes beyond the
  provider swap.
- **IOS-DEEPGRAM-BLUETOOTH-FALLBACK-1** (new) — half-duplex
  fallback if AirPods Pro causes Bluetooth-rate negotiation
  surprises. Fixture variant deferred per RISK 1 reviewer answer.
- **IOS-VOICE-PICKER-SYNC-1** (new) — cross-device voice-id sync
  via Lumo Memory facts (`user_profile.voice_id`). Per RISK 3
  reviewer answer.
