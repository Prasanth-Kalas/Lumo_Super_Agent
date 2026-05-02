# DEEPGRAM-WEB-AUDIO-HOTFIX-1

Branch: `codex/deepgram-web-audio-hotfix-1`

Status: in progress.

Recon:

- Chunked player path: `apps/web/lib/streaming-audio.ts`.
- Voice queue caller: `apps/web/components/VoiceMode.tsx`.
- TTS proxy route: `apps/web/app/api/tts/route.ts`.

Scope:

- Keep one browser playback session open across Deepgram REST Speak MP3 sentence chunks.
- Retry one transient Deepgram 5xx/network failure in `/api/tts` before surfacing a structured retryable 503.
