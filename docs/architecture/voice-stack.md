# Voice stack

How Lumo hears you, speaks back, knows when to stop, and optionally wakes up on command. Single-file user-facing guide is at [users/voice-mode.md](../users/voice-mode.md); this is the "what's behind the button" version.

## The pipeline

```
User speaks
   │
   ▼
[Browser SpeechRecognition]
   │   final transcript
   ▼
[VoiceMode.tsx onUserUtterance]
   │   → shell dispatches as a user message
   ▼
[POST /api/chat]   (orchestrator, same path as typed input)
   │   streaming SSE response text
   ▼
[VoiceMode accumulates spokenText]
   │   sentence boundary
   ▼
[playPremiumTts] ── 503 / non-2xx ──► [speechSynthesis fallback]
   │
   ▼
[POST /api/tts → ElevenLabs → MP3 stream]
   │
   ▼
[MSE MediaSource + audio element]
   │
   ▼
Audio in user's ears
   │
   ▼
[Barge-in monitor: second mic pipeline]
   │   RMS above threshold?
   ▼
If yes: stop audio, switch to listening
If no : onEnd → hands-free restart listening
```

## Components and files

- **`components/VoiceMode.tsx`** — The state machine. Owns the mic, the TTS trigger, the hands-free loop, barge-in orchestration.
- **`lib/streaming-audio.ts`** — MSE-based streaming audio player with blob fallback. Exposes `playAudioStream(response, { onStart, onEnd })`.
- **`lib/barge-in.ts`** — The second mic pipeline that runs while Lumo is speaking. Uses `getUserMedia` + `AudioContext` + an AnalyserNode to compute RMS. Hysteresis keeps it from firing on brief sounds.
- **`lib/wake-word.ts`** — Scaffold for Picovoice Porcupine-based wake detection. Reads `LUMO_PICOVOICE_KEY`; if absent, the handle no-ops.
- **`lib/voice-catalog.ts`** — Static catalog of available voices (Rachel, Sarah, Charlotte, Domi, Antoni, Adam) with display metadata. Voice IDs are ElevenLabs voice IDs.
- **`lib/voice-format.ts`** — Pre-TTS text formatter. Strips markdown, removes emojis, collapses whitespace — the model's output is markdown-flavored, but TTS wants flat prose.
- **`app/api/tts/route.ts`** — The server proxy to ElevenLabs. Keeps the API key server-side and streams the MP3 response body straight through.

## Speech-to-text (STT)

We use the browser's built-in `SpeechRecognition` (a.k.a. `webkitSpeechRecognition` on Chromium/Safari). The reasoning:

- **Zero additional cloud cost** — STT is free on the device.
- **Low latency** — partial transcripts arrive in real time; the final transcript is ready the instant the user stops speaking.
- **Privacy** — audio does not leave the browser unless the browser vendor's default cloud STT does so (Chrome does route to Google for recognition; Safari uses on-device; Edge uses MSFT). The user is in control via their browser's mic permission.

Firefox doesn't support the API. On Firefox, `VoiceMode` detects the absence and renders "Voice not supported — use text" without crashing.

## Streaming TTS

`POST /api/tts` with `{ text, voice_id }` returns an MP3 stream (`audio/mpeg`, `transfer-encoding: chunked`). We use ElevenLabs `/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128`.

### Model choice

Currently `eleven_turbo_v2_5`. We trialled `eleven_v3` briefly — richer prosody on paper, but real-world streaming produced rushed delivery and mid-stream artifacts, so we reverted. Turbo v2.5's ~275 ms first-chunk latency is proven and its prosody is steady. `eleven_flash_v2_5` (75 ms) is the one-liner alternative if latency ever matters more than expressiveness — the flatter delivery is the tradeoff.

Switching models is a one-line change in `app/api/tts/route.ts`:

```ts
const MODEL_ID = "eleven_turbo_v2_5";
// or "eleven_flash_v2_5" / "eleven_v3"
```

### Voice settings

We pass a settings payload tuned for "friend-like" warmth on Turbo v2.5:

```json
{
  "stability": 0.42,
  "similarity_boost": 0.8,
  "style": 0.55,
  "use_speaker_boost": true
}
```

- **Stability 0.42** — dropped from ElevenLabs' 0.5 default. The lower value lets cadence breathe so lines don't sound like a narrator reading a script; any lower and the model starts slurring plosives. 0.42–0.45 is the sweet spot on Turbo v2.5 where prosody opens up without losing pace.
- **Similarity 0.8** — bumped from the 0.75 default to hold voice identity (Rachel) even as stability drops. Without this pairing, the voice drifts character across long responses.
- **Style 0.55** — real emotional inference. The model leans into punctuation cues — em-dashes, ellipses, question marks. Above 0.7 it starts over-acting; 0.55 is the "warm but honest" point we want for the concierge persona.
- **Speaker boost on** — keeps clarity on phone + laptop speakers where mids get muddy.

The tuning history, roughly:
- v3 trial used aggressive settings (stability 0.35, style 0.45) because v3's expressive range absorbed the extra play. Reverted.
- Post-revert conservative pass used defaults (stability 0.5, style 0.3) — safe but read as polite-concierge; users wanted conversational.
- Current settings land in the middle — enough variation to feel human, enough stability for Turbo v2.5 to not crack.

If we ever re-trial v3, expect another round of tuning; these values don't translate across models.

### Streaming mechanics

Upstream emits MP3 frames as they render. We pipe `upstream.body` straight to the client without buffering:

```ts
return new Response(upstream.body, {
  status: 200,
  headers: {
    "content-type": "audio/mpeg",
    "cache-control": "no-store",
    "transfer-encoding": "chunked",
  },
});
```

The client-side `playAudioStream` then feeds bytes into a `MediaSource` `SourceBuffer` with mime `audio/mpeg`. First audio plays after ~one MP3 frame is buffered — typically under 300 ms end-to-end for Turbo; variable but median ~200 ms for v3 in our testing.

## MSE with blob fallback

MediaSource Extensions for MP3 work on Chrome, Edge, Firefox, and desktop Safari. Some mobile Safari builds lie about `isTypeSupported("audio/mpeg")` — they return true but throw on `addSourceBuffer`. When that happens, we catch the throw, tear down MSE, and fall back to buffering the full response as a Blob then playing via `URL.createObjectURL`. Same user-visible behavior, no streaming benefit.

## Barge-in

While Lumo is speaking, a second `getUserMedia` stream runs. The analyser samples RMS at 50 Hz. If RMS stays above the threshold (`0.05` default) for more than 96 ms, we consider it real speech and:

1. `stop()` the in-flight `StreamingAudioHandle` (kills both MSE and blob paths).
2. Emit `onStateChange("listening")`.
3. Hand off to the main `SpeechRecognition` which grabs the user's transcript.

There's a 1.5s cool-off after Lumo finishes speaking before barge-in re-arms, so echo of Lumo's own speech (through open-ear AirPods, for instance) doesn't self-trigger.

## The premium-TTS cooldown (post-incident)

A subtle bug shipped in an earlier build: if `/api/tts` ever returned non-2xx during a session, `premiumStatusRef.current = "unavailable"` was set permanently — the rest of the session used browser TTS even after upstream recovered.

Today's implementation treats "unavailable" as a **timed cooldown** (`PREMIUM_TTS_COOLDOWN_MS = 60_000`). When the cooldown expires, the next chunk re-probes `/api/tts`. If upstream healed, we're back on premium. No reload required.

This matters for a real-world failure shape: ElevenLabs returning 402 Payment Required while a subscription renewed. With the old behavior, every active Lumo tab stayed on browser TTS until refresh. With the cooldown, premium resumes within a minute of billing clearing.

## Wake word (optional)

`lib/wake-word.ts` wraps Picovoice Porcupine. It's imported via a computed string (`require([\"\"picovoice-web\"].join()")`) so TypeScript doesn't resolve the package statically — the module is only loaded at runtime when `LUMO_PICOVOICE_KEY` is present.

When enabled, wake-word detection runs continuously in the browser (never sends audio to any server) and flips voice mode on when it hears "Hey Lumo". The detection is tunable via `WAKE_WORD_SENSITIVITY` — too-low values miss wakes, too-high values false-fire on similar phrases.

Without `LUMO_PICOVOICE_KEY`, the handle returned from `startWakeWord()` has `active=false` and the UI hides the wake-word toggle. Deployments without wake-word support work identically minus that one button.

## Voice selection

`lib/voice-catalog.ts` exports a fixed catalog of voice options. Each entry has:

```ts
{
  id: "21m00Tcm4TlvDq8ikWAM",    // ElevenLabs voice id
  name: "Rachel",
  character: "warm-female",
  description: "Calm and professional. Late-20s American female...",
}
```

The `/memory` VoicePicker component reads the catalog, lets the user Preview each voice, and stores the selected ID in `localStorage["lumo.selectedVoiceId"]`. `VoiceMode` reads that selection before every TTS call.

## Telemetry

- Each `/api/tts` call logs duration + content-length + upstream status in Vercel logs (no text content logged).
- Voice mode doesn't write to `ops_cron_runs` or any DB table — it's stateless server-side apart from the ElevenLabs call.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Silent voice, no MP3 in network tab | `ELEVENLABS_API_KEY` not set, or key invalid | Set the env var; redeploy. |
| Silent voice, /api/tts returns 402 | ElevenLabs subscription lapsed or out of credits | Top up / renew subscription. Cooldown will re-probe within 60s. |
| Voice keeps restarting and cutting itself off | Barge-in over-triggering, usually because laptop speakers make Lumo hear itself | Keep `NEXT_PUBLIC_LUMO_BARGE_IN_ENABLED` unset/false. Only enable it for headphone testing until echo handling is stronger. |
| No mic icon in composer | Firefox (no SpeechRecognition) or OS mic permission denied | Switch browser; grant mic permission. |
| Voice works but is the "cheap robot" | TTS cooldown currently in effect after a transient upstream error | Wait 60s or reload the tab. |

## Related

- [users/voice-mode.md](../users/voice-mode.md) — user-facing guide.
- [orchestration.md](orchestration.md) — voice input/output uses the same orchestrator as typed messages.
- [operators/env-vars.md](../operators/env-vars.md) — `ELEVENLABS_API_KEY`, `LUMO_PICOVOICE_KEY`.
