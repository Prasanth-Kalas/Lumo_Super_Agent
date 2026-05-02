# VOICE-MODE-STT-GATING-1

Started: 2026-05-02  
Branch: `codex/voice-mode-stt-gating-1`

## Scope

Production voice mode is letting STT restart during TTS playback, so Lumo's
own audio or room noise can interrupt a multi-sentence assistant reply. This
lane adds an explicit TTS mic gate in the web voice-mode state machine.

## Implementation Notes

- `VoiceMode.tsx` now keeps STT paused while a TTS chunk is fetching, appending,
  or playing.
- After final TTS playback, the state enters `post_speaking_guard` for the
  configured tail guard before hands-free listening can resume.
- `LUMO_VOICE_TTS_TAIL_GUARD_MS` is parsed with a 300 ms default.
- The legacy barge-in mic monitor stays disabled under the TTS mic gate.
- Manual Stop still cancels TTS and hands control back to the user.

## Verification

- `node --experimental-strip-types tests/voice-mode-stt-gating.test.mjs`
- `node --experimental-strip-types tests/deepgram-web-audio-hotfix.test.mjs`
- `npm run typecheck`
- `npm run lint` (existing warnings only)
- `npm test`
- `npm run build`
- `npm run lint:commits -- origin/main..HEAD`
