# DEEPGRAM-WEB-AUDIO-HOTFIX-2

Branch: `codex/deepgram-web-audio-hotfix-2`

Status: in progress.

Recon:

- `origin/main` did not include `codex/deepgram-web-audio-hotfix-1`, so this branch first folds in HOTFIX-1's chunked MSE player and retry baseline.
- Current Deepgram docs place Aura-2 speed control on the REST Speak query string as `speed`, with range `0.7` to `1.5` and default `1.0`.
- Server retry path now needs per-attempt diagnostic logging because production 503s were not observable from the client.
- Vercel log probe (`npx vercel@latest logs --project lumo-super-agent --environment production --since 2h --query tts --json --no-branch`) showed `/api/tts` 200s with unrelated `admin_settings` schema-cache warnings, but no upstream Deepgram body because HOTFIX-2 diagnostics were not deployed yet. `--status-code 503` returned no rows in the sampled window.

Scope:

- Log every Deepgram Speak attempt as a structured `tts_deepgram_attempt` event without logging request text or API keys.
- Retry up to three fresh Deepgram fetch attempts with a fresh `AbortController` and request body per attempt, plus a 200ms backoff.
- Add `LUMO_DEEPGRAM_TTS_SPEED`, defaulting to `0.9`, to slow Aura-2 output by 10%.
