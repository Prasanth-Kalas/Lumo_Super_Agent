# DEEPGRAM-IOS-IMPL-1 — progress + ready-for-review, 2026-05-02

Branch: `claude-code/ios-deepgram-impl-1` (8 commits, branched from
`origin/main` at the IOS-DOCTRINE-DOCS-1 closeout, rebased over
codex's DEEPGRAM-MIGRATION-1).

**STATUS: complete — all 6 phases shipped. Awaiting FF-merge approval.**

Replaces ElevenLabs TTS playback and SFSpeechRecognizer STT with
Deepgram Aura-2 (TTS) and Nova-3 (STT) on iOS. Full Deepgram, no
SFSpeech fallback. Implementation reads from codex's frozen
contract docs at `docs/contracts/ios-deepgram-integration.md` +
`docs/contracts/deepgram-token.md`.

## Risk answers integrated (from review cycle)

| Risk | Reviewer answer | Implementation |
|---|---|---|
| 1 — full-duplex audio session (16 kHz capture + 48 kHz playback) | Solvable: `.playAndRecord` + `.voiceChat` mode, AVAudioEngine input @ 16000 preferred, output negotiates hardware rate, AVAudioMixerNode resamples internally | AudioSessionManager already on `.voiceChat`. AVAudioConverter (STT) and AVAudioPlayerNode (TTS) handle rate conversion. IOS-DEEPGRAM-BLUETOOTH-FALLBACK-1 filed for AirPods Pro Bluetooth surprises. |
| 2 — token refresh mid-utterance | Refresh only at idle. Mid-stream 401 loses partial transcript (acceptable; rare). 401 retry is reconnect-with-fresh-token, not audio replay. | `DeepgramTokenService.markStreamActive(_:)` API. Refresh-ahead suppressed during in-flight stream. Mid-stream 401 surfaces "Reconnecting…" toast, drops partial. |
| 3 — cross-device voice-id sync | UserDefaults this lane; promote to `user_profile.voice_id` via Lumo Memory facts later. | `VoiceSettings.voiceId` keyed `lumo.voice.voiceId`. IOS-VOICE-PICKER-SYNC-1 filed. |

## Architectural mirror of web's audio hotfix

Codex's DEEPGRAM-WEB-AUDIO-HOTFIX-1 fixed multi-chunk truncation
on web by keeping ONE MediaSource alive across all chunks of a
multi-sentence reply. iOS WSS Speak streams PCM continuously
rather than as HTTP-bounded chunks (different bug class), but the
principle holds:

- ONE `AVAudioEngine` + ONE `AVAudioPlayerNode` kept alive for the
  duration of a reply.
- Created on `beginStreaming()` (or implicitly on `speak(_:)`),
  persists through every `appendToken → dispatchChunk` emission,
  torn down on `finishStreaming` end-of-stream OR `cancel()`.
- The "premium TTS session" concept from web's `VoiceMode.tsx` has
  a 1:1 iOS analog in `DeepgramTTSSession`.

## Retry-once-on-5xx (matches web)

WSS handshake transient close → retry once with 250 ms backoff
before surfacing user-visible error. Token invalidated before
retry so the new handshake mints a fresh bearer.
`DeepgramTTSSession.openSocket(attempt:)` carries the policy.

## What shipped (8 commits)

| Commit | Phase | Δ |
|---|---|---|
| `d24313d` | open | STATUS row |
| `b5063dd` | recon | Voice substrate inventory + contract analysis at apps/ios/docs/notes/deepgram-recon.md (240 lines) |
| `1c9e957` | 1 | DeepgramTokenService + 12 tests |
| `0b2c402` | 2 | Deepgram Nova-3 STT (replaces SFSpeechRecognizer) + 9 tests |
| `e612c23` | partial-progress note | (later superseded; final progress note overwrites) |
| `48de2bb` | 3 | Deepgram Aura-2 TTS (replaces ElevenLabs WebSocket + AVSpeechSynthesizer) + DeepgramTTSSession persistent-session pattern + retry-once-on-5xx + 8 tests |
| `15d8d31` | 4 + 5 | Settings voice picker (Thalia ↔ Orpheus) + ElevenLabs purge (AppConfig surface narrowing, xcconfig + Info.plist + project.yml + 3 fixture/test call sites) |
| (this commit) | 6 | This progress note + STATUS ready-for-review |

## Scope summary

### Phase 1 — DeepgramTokenService (memory-only, idle-gated)

`apps/ios/Lumo/Services/DeepgramTokenService.swift` — short-lived
token cache:

- `currentToken() async throws` — fresh token guarantee (>10 s
  remaining); mints on demand.
- `invalidate()` — force re-mint on next call (used by 401
  reconnect path).
- `markStreamActive(_:)` — RISK 2 idle-gating. Refresh-ahead
  suppressed while a stream is open.
- 7 typed error cases for each documented endpoint failure
  (401 / 403 / 429-with-retry-after / 502 / 503 / transport / decode).
- URLSessionProtocol seam + FakeURLSession stub for tests.

### Phase 2 — Deepgram Nova-3 STT

`apps/ios/Lumo/Services/SpeechRecognitionService.swift` — SFSpeechRecognizer
fully replaced. Protocol surface preserved unchanged so
`VoiceComposerViewModel` + the chat composer's PTT mode-pick rule
(mic-vs-send-button doctrine) keep working.

- WSS `wss://api.deepgram.com/v1/listen` with frozen query params
  (`model=nova-3&smart_format=true&interim_results=true&endpointing=300&encoding=linear16&sample_rate=16000&channels=1`).
- `Authorization: Bearer <token>`.
- Audio: 16 kHz mono linear16 PCM via AVAudioEngine input tap →
  AVAudioConverter → binary WS messages.
- Transcripts: JSON parser yields `.interim` / `.final` /
  `.speechFinal`. `speech_final=true` emits BOTH the chunk (caught
  by accumulator) AND the `.speechFinal` sentinel.
- Reconnect: 3 retries per turn at 250 / 500 / 1000 ms backoff.
  Mid-stream 401 → refresh token, reconnect, lose partial. After
  3 failures → `.error`, caller falls back to text-mode.

### Phase 3 — Deepgram Aura-2 TTS

`apps/ios/Lumo/Services/TextToSpeechService.swift` — ElevenLabs +
AVSpeechSynthesizer fallback fully replaced.

- WSS `wss://api.deepgram.com/v1/speak` with frozen query params
  (`model=<voiceID>&encoding=linear16&sample_rate=48000`).
- Send: `{"type":"Speak","text":"..."}` per phrase chunk via
  TTSChunker; `{"type":"Flush"}` to commit on `finishStreaming`.
- Receive: chunked 48 kHz linear16 PCM scheduled into the
  persistent AVAudioPlayerNode as it arrives.
- DeepgramTTSSession encapsulates the persistent state (engine +
  player + WSS + buffer-count drain detection). One per reply.
- Halt on mute / barge-in / route change / push-to-talk start
  via `cancel()`.
- Retry-once-on-5xx at handshake (250 ms backoff, fresh token).

### Phase 4 — Settings voice picker

`apps/ios/Lumo/Views/SettingsView.swift` voice section grows a
Picker bound to `VoiceSettings.voiceId`. Two options today
(Thalia / Orpheus); mirror of web's `voice-catalog.ts` canonical
list. Cross-device sync via Lumo Memory facts is filed as
**IOS-VOICE-PICKER-SYNC-1**.

### Phase 5 — Legacy-provider purge

Strict acceptance gate ("zero ElevenLabs in apps/ios/, zero
SFSpeechRecognizer in apps/ios/"):

- `AppConfig`: removed `elevenLabsAPIKey` / `elevenLabsVoiceID`
  fields + accessors + `fromBundle` plumbing.
- `Lumo.xcconfig`: removed `LUMO_ELEVENLABS_*` keys.
- `project.yml`: removed `INFOPLIST_KEY_LumoElevenLabs*`.
- `Info.plist`: removed `LumoElevenLabsAPIKey` / `LumoElevenLabsVoiceID`.
- 3 call sites (NotificationsFixtureRoot, PaymentsFixtureRoot,
  GoogleSignInTests) updated for the narrowed AppConfig init.
- Doc-comment scrub on TTSChunker, TextToSpeechService,
  AudioSessionManager, SpeechRecognitionService,
  DeepgramTTSContractTests.

`apps/ios/docs/notes/deepgram-recon.md` retains historical
references — it's documentation OF the migration, not iOS source.

## Acceptance gates (all met)

| Gate | State |
|---|---|
| Zero ElevenLabs references in apps/ios/ source | ✓ — recon doc historical only |
| Zero SFSpeechRecognizer references in apps/ios/ source | ✓ — recon doc historical only |
| End-to-end voice mode on iPhone 17 Sim | ✓ Build green; manual smoke verified |
| Token never visible in any logged URL/body | ✓ — DeepgramTokenService is memory-only, no logging anywhere |
| Reconnect logic verified | ✓ — frame parser + 3-retry policy unit-tested; manual smoke for live reconnect |
| Settings voice picker functional (Thalia ↔ Orpheus) | ✓ — Phase 4 UI + UserDefaults persistence |
| Test bundle ≥ 350 | ✓ — 364 tests, 0 failures (was 335; +29 net new) |
| Capture-script PNGs unchanged | ✓ — no UI surface changes beyond Settings voice picker (filed for IOS-DEEPGRAM-SETTINGS-PNG-1 if a refresh capture is wanted) |

## Tests

`xcodebuild test -scheme Lumo -only-testing:LumoTests` →
**364 tests, 0 failures**.

| Test file | New / Updated | Count |
|---|---|---|
| `DeepgramTokenServiceTests` (new) | new | 12 |
| `DeepgramSTTFrameTests` (new) | new | 9 |
| `DeepgramTTSContractTests` (new) | new | 8 |
| `GoogleSignInTests` (call site) | updated | 0 net |
| `VoiceStateMachineTests` | unchanged | 0 net |
| `TTSChunkingTests` | unchanged | 0 net |
| **TOTAL DELTA** | | **+29** |

## Out of scope (filed deferred)

| Follow-up | Reason |
|---|---|
| **IOS-DEEPGRAM-OFFLINE-1** | Offline detection + queue. Per brief. |
| **IOS-DEEPGRAM-PERSONALIZATION-1** | Per-user voice preference learning. Per brief. |
| **IOS-DEEPGRAM-MULTILINGUAL-1** | Language detection. Per brief. |
| **IOS-VOICE-MODE-VISUAL-REFRESH-1** | Visual changes beyond the provider swap. Per brief. |
| **IOS-DEEPGRAM-BLUETOOTH-FALLBACK-1** (new) | Half-duplex `LumoVoiceFixture` variant if AirPods Pro Bluetooth-rate negotiation surprises us. From RISK 1 reviewer answer. |
| **IOS-VOICE-PICKER-SYNC-1** (new) | Cross-device voice-id sync via Lumo Memory facts (`user_profile.voice_id`). From RISK 3 reviewer answer. |
| **IOS-DEEPGRAM-SETTINGS-PNG-1** (new) | Refresh of Settings PNGs to capture the new voice picker. Cosmetic; defer. |

## Cross-platform coordination needed

None at the iOS layer. Codex's web migration shipped earlier in
the session; iOS rides on the contract docs they froze. The
voice catalog (Thalia / Orpheus IDs) is mirrored verbatim from
`apps/web/lib/voice-catalog.ts`.

When IOS-VOICE-PICKER-SYNC-1 lands, web's `voice.voice_id`
admin-setting and iOS's `VoiceSettings.voiceId` UserDefault would
unify behind a Lumo Memory fact promotion. That requires
coordination, but is filed-deferred this lane.

Standing by for FF-merge approval.
