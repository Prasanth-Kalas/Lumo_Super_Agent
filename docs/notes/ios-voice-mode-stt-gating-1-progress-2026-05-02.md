# IOS-VOICE-MODE-STT-GATING-1 — progress + ready-for-review, 2026-05-02

Branch: `claude-code/ios-voice-mode-stt-gating-1` (single push,
2 commits, branched from `origin/main` at the
DEEPGRAM-WEB-AUDIO-HOTFIX-2 closeout).

iOS mirror of codex's `b65ca9d` VOICE-MODE-STT-GATING-1. Production
voice mode was letting STT restart during TTS playback, so Lumo's
own audio (or room noise during the brief gap between TTS chunks)
could interrupt a multi-sentence assistant reply. This lane adds
the explicit TTS mic gate to the iOS voice-mode state machine that
codex shipped on web.

## What shipped

### `apps/ios/Lumo/Services/SpeechModeGating.swift` — pure helpers

Mirrors codex's `apps/web/lib/voice-mode-stt-gating.ts` function-
for-function so the cross-platform gate behaves identically and a
future shared-types codegen pass could lift the helpers onto a
single contract.

| Web symbol | iOS symbol |
|---|---|
| `VoiceModeMachinePhase` (string union) | `VoiceModeMachinePhase: String, Equatable` (raw values match exactly) |
| `DEFAULT_VOICE_TTS_TAIL_GUARD_MS = 300` | `LumoVoiceConfig.defaultTtsTailGuardMs = 300` |
| `MAX_VOICE_TTS_TAIL_GUARD_MS = 2_000` | `LumoVoiceConfig.maxTtsTailGuardMs = 2_000` |
| `normalizeVoiceTtsTailGuardMs(value)` | `SpeechModeGating.normalize(tailGuardMs:)` |
| `isMicPausedForVoicePhase(phase)` | `SpeechModeGating.isMicPaused(phase:)` |
| `canResumeListeningAfterTts(input)` | `SpeechModeGating.canResumeListeningAfterTts(input:)` |
| `expectedTtsResumeSequence(handsFree)` | `SpeechModeGating.expectedTtsResumeSequence(handsFree:)` |

`LumoVoiceConfig.ttsTailGuardMs` is a build-time constant resolved
once at app launch via `Bundle.main.object(forInfoDictionaryKey:
"LumoVoiceTTSTailGuardMs")`, normalized through the same clamp
(0–2000 ms, default 300). The normalize helper accepts `Int`,
`Double`, and `String` inputs (mirrors codex's tolerant
parsing — JS `Number()` then `Math.round`).

### `VoiceComposerViewModel` — parallel `phase` track

State and phase are **orthogonal**, mirroring codex's
`voiceMachinePhase` ref alongside `state` in VoiceMode.tsx:

- `state` tracks what the USER is doing (`idle / listening /
  ready / requestingPermissions / permissionDenied / error`).
- `phase` tracks what the AGENT VOICE subsystem is doing
  (`agentThinking / agentSpeaking / postSpeakingGuard /
  listening`).
- `isMicPausedForTts` is derived from phase via
  `SpeechModeGating.isMicPaused(phase:)`.

### TTS observer wiring

New `observe(tts:)` API on `VoiceComposerViewModel` subscribes to
`TextToSpeechServicing.stateChange` and drives phase transitions:

| TTS state | Phase transition |
|---|---|
| `.speaking` | → `.agentSpeaking` (gate ON; cancel any pending tail-guard) |
| `.finished` | → `.postSpeakingGuard` (gate stays held), schedule `.listening` after `tailGuardMs` |
| `.error` | → `.listening` IMMEDIATELY (defensive) |
| `.fallback` | → `.listening` IMMEDIATELY (defensive) |
| `.idle` (while gated) | → `.listening` IMMEDIATELY (cancel/teardown path) |

Wired in `RootView.body.task` so the observer attaches once both
view-models exist.

### Gate enforcement

`tapToTalk()` and `pressBegan()` now early-return when
`SpeechModeGating.isMicPaused(phase: phase)` is true. The
underlying `SpeechRecognitionService` is never started during
`AGENT_SPEAKING` / `POST_SPEAKING_GUARD`, so the input feed is
fully paused — there's no chance of Lumo's own audio bleeding into
a Deepgram transcript.

`cancel()` / `release()` / barge-in semantics are unchanged. Manual
Stop still pulls the user's `state` back to idle regardless of
phase; the phase track continues to reflect TTS lifecycle until
the TTS service itself emits `.idle` / `.error` / `.fallback`.

### Defensive: dropped TTS clears the gate

The bug class codex flagged during their review: a TTS WebSocket
that drops mid-stream must not leave the gate stuck on
`AGENT_SPEAKING` forever. Mirror of web's `cancelTts` defensive
clear:

```swift
case .error, .fallback:
    cancelTailGuard()
    phase = .listening
case .idle:
    if SpeechModeGating.isMicPaused(phase: phase) {
        cancelTailGuard()
        phase = .listening
    }
```

`test_ttsError_midSpeaking_clearsGateImmediately` and
`test_ttsFallback_midSpeaking_clearsGateImmediately` lock this
behaviour.

## Tests

`xcodebuild test -scheme Lumo -only-testing:LumoTests` →
**388 tests, 0 failures** (was 364 before the lane: +14 in
`SpeechModeGatingTests`, +10 in `VoiceComposerSttGatingTests`).

Brief target was ~370; we landed at 388 with cleaner coverage —
each helper function gets its own bucket-named test, and the
defensive dropped-TTS edge has 3 tests (error / fallback / idle).

`SpeechModeGatingTests` (14 tests):
- `expectedTtsResumeSequence` hands-free vs explicit-listen.
- `isMicPaused` per phase (4 cases).
- `canResumeListeningAfterTts` happy + 5 individual blocked
  paths.
- `normalize` default / Int / Double / String / negative-clamp /
  max-clamp / unparseable-falls-back.
- Phase raw values match cross-platform telemetry strings
  (locked so the gate stays comparable across iOS + web).

`VoiceComposerSttGatingTests` (10 tests):
- Default phase is `.listening`.
- TTS `.speaking` → `.agentSpeaking`.
- TTS `.finished` → `.postSpeakingGuard` → (tail guard) →
  `.listening`.
- `tapToTalk` during `AGENT_SPEAKING` is dropped.
- `pressBegan` during `POST_SPEAKING_GUARD` is dropped.
- TTS `.error` mid-speaking clears gate immediately.
- TTS `.fallback` mid-speaking clears gate immediately.
- TTS `.idle` from speaking/guard clears gate.
- `tapToTalk` after tail guard expires reaches `.listening`.
- `cancel()` returns user state to idle (manual barge-in
  preserved).

## Cross-platform coordination

`VoiceModeMachinePhase` raw values are byte-identical to codex's
web string union (`AGENT_THINKING` / `AGENT_SPEAKING` /
`POST_SPEAKING_GUARD` / `LISTENING`). Future telemetry comparing
phase distributions across iOS + web won't need a translation
table.

The build-time tail-guard knob (`LumoVoiceTTSTailGuardMs`
Info.plist key) is iOS-only; web uses
`NEXT_PUBLIC_LUMO_VOICE_TTS_TAIL_GUARD_MS` env. They tune the
same dwell window via different surfaces — fine for now, future
unification could be a single `voice.tail_guard_ms` admin-setting.

## Bundles into IOS-DEEPGRAM-DEVICE-SMOKE-1

The smoke lane explicitly notes: "Kalas's device smoke test should
be re-run after this lane lands." This change is the prerequisite
fix for the multi-sentence-truncation failure mode the smoke would
have caught — without the gate, the post-c438e81 build would let
the mic re-engage between TTS chunks and feed Lumo's own audio
back through Deepgram STT, which is exactly the symptom the
device smoke is designed to surface.

Recommended re-run pass criteria still hold:
1. "describe the ocean in three short sentences" → all three
   sentences play end-to-end.
2. "tell me a fun fact" ×5 → no provider-side regression after
   repeated sessions.
3. Bluetooth headphones probe → IOS-DEEPGRAM-BLUETOOTH-FALLBACK-1
   risk.

## Out of scope

- Hands-free auto-resume on iOS — the `canResumeListeningAfterTts`
  contract is preserved and the LISTENING terminal phase is
  reached after the tail guard, but iOS doesn't have a hands-free
  surface today (we only have explicit tap-to-talk + hold-to-talk).
  When IOS-VOICE-MODE-HANDS-FREE-1 lands (not filed yet; brief-
  pending), the `canResumeListeningAfterTts` gate already-AND'd
  is the integration point.
- Telemetry capture of phase transitions to a new
  `agent_voice_phase_compare` table — out of scope; codex's web
  side doesn't ship telemetry capture either.
