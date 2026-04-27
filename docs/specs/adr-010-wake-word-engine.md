# ADR-010 — Wake Word Engine

**Status:** Accepted (sealed 2026-04-27). Codex WAKE-1 implements against this ADR.
**Authors:** Coworker A (architecture pass), reviewed by Kalas.
**Related:** `docs/specs/lumo-intelligence-layer.md`,
`docs/specs/phase-4-outlook.md` (Anchor 2),
`docs/specs/adr-012-voice-cloning-biometric-consent.md`,
`docs/specs/phase-3-master.md` (WAKE-1 entry).
**Implements:** the on-device "Hey Lumo" detector that opens the audio
pipe to Lumo only after a local match.

---

## 1. Context

Phase-4 Anchor 2 (voice presence) is non-starter unless the wake-word
path is genuinely on-device. Always-listening server-side is rejected
as a privacy posture: the user's microphone may not stream raw audio
to Lumo's infrastructure ahead of an explicit, locally-detected wake
trigger. The wake-word engine is the primitive that enforces that
invariant.

The decision is which engine, on what platform, with what guardrails.

The two real candidates:

- **Picovoice Porcupine** — commercial wake-word engine. Fully
  on-device. Has SDKs for browser (WASM), iOS, Android, Linux,
  macOS. Mature, well-benchmarked, ~98% TPR / <1 false-accept per
  10 hours on common keywords.
- **Custom small CNN on browser WebAudio** — train a 60-100k-param
  CNN on a "Hey Lumo" dataset, ship it as ONNX, run in WASM via
  onnxruntime-web. Open implementation (`openWakeWord`,
  Mycroft Precise) gives us a starting point.

---

## 2. Options considered

### Option (A) — Picovoice Porcupine, all platforms

License Picovoice (enterprise tier, ~$3k/yr flat for our user
volume). Use their browser WASM, iOS Swift, Android Kotlin SDKs.
Train a custom "Hey Lumo" wake-word model via their console.

**Pros.** Best-in-class accuracy and battery profile in production
deployments. No model training operational burden — Picovoice's
console produces the keyword binary, we just ship it. WASM bundle
is ~2MB compressed; browser CPU usage <5% on a quiet thread.
iOS/Android SDKs handle the foreground-service lifecycle.

**Cons.** Commercial license, vendor lock-in. Pricing tiered by
device count; if user growth outpaces our license, costs spike.
Source-closed — we cannot audit the detector, only the SDK
surface.

### Option (B) — Custom small CNN

Train a small CNN on a public wake-word dataset (Google Speech
Commands + a "Hey Lumo" augmentation set we record). Ship as ONNX,
run via WASM in browser, via Core ML on iOS, via TFLite on
Android.

**Pros.** Open. No vendor cost. Full control over the detector
parameters (sensitivity, gating, retraining cadence). No license
math to do as we scale.

**Cons.** Training data collection is a real piece of work — to
match Porcupine's accuracy, we'd need ~1000 "Hey Lumo" samples
across diverse speakers, accents, and environments. Maintaining
the model (re-training when accents drift, when new noise
environments appear) is engineering time we don't have in v1.
Battery profile of an unoptimised CNN is usually worse than a
hand-tuned commercial detector.

### Option (C) — Hybrid: Porcupine in production, custom CNN as fallback

Ship Porcupine as the production engine. Maintain a custom CNN as
a *standby* — versioned interface lets us swap if licensing cost
spikes or Picovoice changes terms. The CNN does not have to match
Porcupine's accuracy; it has to be good enough that we can flip
within a sprint if needed.

---

## 3. Decision

**Adopt Option (B) for v1: custom on-device wake-word detection first,
with Picovoice Porcupine kept as a paid fallback only if the custom
engine misses the acceptance targets.**

Rationale:

- Phase 3's CFO constraint is explicit: build our own where practical
  and avoid recurring vendor fees until a capability gap is proven.
  Wake-word detection is feasible locally with WebAudio + a small
  ONNX/TFLite model, so paid licensing is not the default path.
- Vendor fallback is preserved by the abstraction. Codex implements
  `lib/wake-word/engine.ts` with a single `detect(audioFrame) ->
  { matched: bool, confidence: number, ts_ms: number }` interface.
  The custom engine is one implementation; Porcupine is another. Swap
  is a constructor change if quality data justifies the spend.
- Custom-CNN training data starts collecting now (opt-in, from
  enrolled-voice-clone users only — see ADR-012). We will have a
  real dataset by Phase-5 if we need to tune or retrain.

---

## 4. Privacy invariant

**Non-negotiable: no audio leaves the device until the wake word
fires locally.**

Implementation requirements:

- The audio capture pipeline runs entirely in the browser
  (`AudioContext` + `AudioWorkletNode`) or in the mobile-native SDK.
  The wake-word detector consumes 16kHz mono PCM frames in-place.
- Frames are processed in a rolling buffer of 1.5 seconds, dropped
  in-place. There is no `fetch`/`XHR`/socket `send` in the
  pre-wake path. CI test asserts the bundle's pre-wake code path
  has no network access surface (lint rule + integration test that
  tcpdumps the network during a 60-second silent capture).
- Once the detector fires, audio capture continues for up to 8
  seconds (the user's command), at which point the post-wake
  buffer is sent to the on-device or server-side STT (see RUNTIME-1).
  The post-wake transmission is the *only* time audio leaves the
  device.
- The mic-active LED/icon (see §6 UX) is on the entire time the
  microphone is open, including the pre-wake listening phase.

The privacy invariant is enforced *technically* (no network code
in the pre-wake path) and *audited* (the tcpdump CI test).

---

## 5. Quality targets

These become Codex's acceptance criteria.

| Metric | Target | Notes |
|---|---|---|
| True-positive rate | ≥ 95% | Measured on a held-out set of 200 "Hey Lumo" utterances across 10 speakers, 3 noise environments |
| False-accept rate (ambient) | < 1 per 24h | Measured on a 24h continuous capture with ambient TV/conversation in the background |
| Detection latency (frame to fire) | p95 < 250ms | Measured frame-arrival to `matched=true` callback |
| Bundle size (browser) | < 3MB compressed | Including the keyword binary |
| CPU usage (browser, idle listening) | < 5% on M1 / < 10% on a 2020 mid-range Android | Measured via `performance.measure` over 60s windows |
| Battery delta (mobile, 30-min idle listening) | < 5% additional drain vs. mic off | Measured on iPhone 13 + Pixel 7 reference devices |

If any of these fail at smoke-test time, the engine ships behind
`LUMO_WAKE_WORD_ENABLED=false` until tuned. We do not ship a
broken wake-word experience.

---

## 6. UX requirements

### Settings flag

- Wake-word feature is **off by default for every user.** Users opt
  in via Workspace → Settings → Voice → "Hey Lumo wake word" with
  a checkbox. The opt-in writes a row to `consent_audit_log` with
  `action='wake_word_enabled'` (see ADR-012 for audit shape).
- Opt-out is a single click in the same settings panel. Opt-out
  writes a `wake_word_disabled` audit row and stops the audio
  capture immediately.

### Mic-active indicator

- Whenever the microphone is open (pre-wake or post-wake), a
  visible indicator must be on:
  - Browser: a small mic icon in the Lumo navbar with a "listening"
    label and a tooltip "Mic on. Lumo is listening for 'Hey Lumo'.
    Click to disable."
  - iOS/Android: standard system-level mic indicator (handled by
    OS) plus an in-app badge.
- The indicator flashes briefly (1s pulse) when the wake word
  fires, signalling the transition from passive listening to
  active capture.
- The user can click the indicator to immediately stop capture.
  Clicking writes an `interrupted_listening` audit row.

### Battery management

- Auto-sleep after 30 minutes of idle listening (no wake fires).
  Wake-up requires a user gesture (focus the Lumo tab in browser,
  or open the Lumo app on mobile). Documented in the settings
  panel: "To save battery, Lumo stops listening after 30 minutes
  of inactivity. Open the app to resume."
- Wake-word listening is suspended when the device is on battery
  below 20% (mobile) or when the browser tab is in the background
  for >5 minutes (desktop). Both behaviours are surfaced in the UI
  ("Listening paused — battery low" / "Listening paused — tab in
  background").
- Foreground-service notification on Android (required by
  `RECORD_AUDIO` foreground policy): "Lumo is listening for 'Hey
  Lumo'." User can tap to disable.

### First-run consent flow

When a user enables wake-word, the consent flow shows:

1. The privacy invariant in plain language ("Audio stays on your
   device until you say 'Hey Lumo'.").
2. A 5-second test capture to verify the mic works.
3. A single "I understand" button that writes the audit row and
   activates the engine.

The flow is mandatory. No silent enable, no auto-enable from
elsewhere in the UI.

---

## 7. Implementation shape

```typescript
// lib/wake-word/engine.ts

export interface WakeWordEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'wake' | 'error', cb: (payload: WakeEvent) => void): void;
  destroy(): Promise<void>;
}

export interface WakeEvent {
  ts_ms: number;
  confidence: number;
  engine: 'custom_cnn' | 'openwakeword' | 'porcupine';
}

// Two implementations behind the same interface:
// - lib/wake-word/custom_cnn.ts (default, behind LUMO_WAKE_WORD_ENGINE='custom_cnn')
// - lib/wake-word/porcupine.ts (paid fallback, behind LUMO_WAKE_WORD_ENGINE='porcupine')
```

The orchestrator subscribes to the `wake` event. On fire, it:

1. Triggers the post-wake STT capture (RUNTIME-1).
2. Records a `wake_word_fired` row in `agent_tool_usage`.
3. Activates the post-wake mic-indicator pulse.

If the engine emits `error` (mic permission revoked, frame
processing crash), the orchestrator stops capture, writes an
audit row, and surfaces a non-modal banner: "Wake word listening
stopped — please re-enable in settings."

---

## 8. Latency and fallbacks

- Engine detection latency budget: p95 < 250ms (frame to fire).
- Post-wake → STT first-token latency target: p95 < 800ms (covered
  in RUNTIME-1).
- Total "Hey Lumo, what's left on my plate" → first audio response
  byte: p95 < 2.5s (covered in the Phase-4 ship gate, not WAKE-1).

Fallback rules:

- If the custom engine fails to load, engine
  enters degraded mode: writes an error row, surfaces an in-app
  banner, and does NOT silently fall back to a paid provider. The
  vendor swap is a deliberate flag, not an emergency.
- If the engine throws during a frame, the audio worklet drops
  the frame and continues. Three consecutive frame errors stop
  the engine entirely.
- If the user's mic permission is revoked mid-session, the engine
  stops, writes an audit row, and surfaces the consent flow again
  on next interaction.

---

## 9. Acceptance criteria for WAKE-1

WAKE-1 ships when:

1. `lib/wake-word/engine.ts` interface is implemented with the
   custom backend live in browser. Mobile follows in WAKE-1.5
   after the browser engine meets quality targets.
2. The settings panel surface is live (off by default), the
   consent flow is implemented, and the mic-active indicator
   renders correctly.
3. The privacy-invariant CI test (tcpdump during silent capture)
   is green for 7 consecutive nightly runs.
4. The held-out TPR/FAR test reports TPR ≥ 95%, FAR < 1/24h on
   the v1 evaluation set.
5. `consent_audit_log` rows fire correctly for enable/disable/
   interrupted_listening events.
6. End-to-end smoke: a user enables wake-word, says "Hey Lumo,
   what's the weather", the wake fires, post-wake audio reaches
   STT, the orchestrator returns an answer. End-to-end latency <
   2.5s on the reference device.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Custom engine misses quality targets | Picovoice fallback is built behind same interface, but activation requires explicit spend approval |
| FAR climbs in noisy environments | Per-user sensitivity slider in settings (3 levels); periodic ambient-FAR telemetry |
| Battery drain feedback from users | 30-min idle sleep, low-battery suspend, foreground-service notification |
| Mic permission revoked silently | Engine checks permission on every wake fire; surfaces consent flow on revoke |
| Pre-wake audio accidentally exfiltrated | Lint rule blocks network code in pre-wake path; tcpdump CI test |
| Wake-word collision with another app's "Hey Lumo" feature | Unlikely — "Lumo" is distinct enough — but documented as a Phase-5 monitor |
| Accent or speech-impediment FAR/TPR drift | Collect opt-in aggregate failure counts; per-user tuning is Phase-5+ after privacy review |

---

## 11. Open questions

1. Do we offer the user a choice of wake words ("Hey Lumo" /
   "Lumo" / custom)? v1 ships "Hey Lumo" only. Per-user custom
   wake words are a Phase-5 feature.
2. Should the engine continue listening through a system call
   (incoming phone call, user is in a meeting)? v1 stops
   listening when any other app captures the mic; resumes when
   it releases.
3. Per-user FAR telemetry — collected as a count, never as audio.
   v1 collects the count.
4. Wake-word for users who have not enrolled a voice clone — yes,
   wake-word is independent of voice cloning. ADR-012 covers
   voice-cloning consent separately.

---

## 12. Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | Adopt custom on-device wake-word detection for v1 production path |
| 2026-04-27 | Maintain Picovoice Porcupine as paid fallback behind a versioned wake-word interface |
| 2026-04-27 | Wake word default off; explicit per-user opt-in required |
| 2026-04-27 | Privacy invariant: no audio leaves device until wake fires locally; enforced by lint + tcpdump CI test |
| 2026-04-27 | Targets locked: TPR ≥ 95%, FAR < 1/24h, p95 detection < 250ms, < 5% CPU idle, < 5% battery delta |
| 2026-04-27 | Mic-active indicator required whenever the mic is open (pre- and post-wake) |
| 2026-04-27 | Auto-sleep after 30 minutes idle; suspend on low battery / backgrounded tab |
