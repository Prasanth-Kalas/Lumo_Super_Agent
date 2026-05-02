/**
 * POST /api/tts — premium text-to-speech proxy.
 *
 * Request body:  { text: string, voice_id?: string }
 * Response:
 *   200 audio/mpeg  — streamed MP3 audio, pipe straight into <audio>.
 *   503 json        — { reason: "tts_not_configured" } when no server-side
 *                     provider key is set. The client falls back to browser
 *                     speechSynthesis.
 *   502 json        — upstream provider failure.
 *
 * Why proxy instead of calling the provider from the browser:
 *   - API key stays server-side. Provider tokens are usage-metered and
 *     we're not shipping them to every browser.
 *   - Rate-limiting + per-user throttling (TODO) can happen here.
 *   - Lets us swap providers without touching the client. Deepgram is the
 *     default provider; the legacy provider remains behind LUMO_TTS_PROVIDER
 *     for the seven-day cutover rollback window.
 *
 * Streaming: Deepgram's REST Speak endpoint returns MP3 audio and supports
 * progressive response bodies. We pipe the provider body directly to the
 * browser and instrument the first emitted audio chunk for the cutover table.
 */

import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { getSetting, isFeatureEnabled } from "@/lib/admin-settings";
import {
  DEFAULT_DEEPGRAM_TTS_VOICE,
  deepgramSpeakRestUrl,
  normalizeDeepgramVoice,
} from "@/lib/deepgram";
import {
  instrumentAudioStream,
  recordVoiceProviderCompare,
} from "@/lib/voice-provider-compare";
import {
  inferVoiceEmotion,
  tuneVoiceForEmotion,
  type VoiceEmotion,
} from "@/lib/voice-emotion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Compile-time fallbacks. Admin-settings overrides win at runtime;
// these are what the route uses if the DB is unreachable or the
// settings rows are missing.
const DEFAULT_VOICE_ID = DEFAULT_DEEPGRAM_TTS_VOICE;
const DEFAULT_MODEL_ID = DEFAULT_DEEPGRAM_TTS_VOICE;
const DEFAULT_STABILITY = 0.42;
const DEFAULT_SIMILARITY = 0.8;
const DEFAULT_STYLE = 0.55;

// Hard caps so a runaway turn doesn't burn through provider quota. Speech at
// ~150wpm ≈ 13 chars/sec, so 5000 chars is roughly a six-minute monologue —
// longer than any reasonable concierge turn should be.
const MAX_TEXT_CHARS = 5000;
const LEGACY_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const LEGACY_ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";

interface Body {
  text?: string;
  voice_id?: string;
  emotion?: VoiceEmotion;
  session_id?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  // Voice mode disabled by feature flag → tell the client to use
  // browser speechSynthesis. Same response shape as "not configured"
  // so the client's existing fallback path handles it.
  const voiceEnabled = await isFeatureEnabled(
    "feature.voice_mode_enabled",
    true,
  );
  if (!voiceEnabled) {
    return json(503, { reason: "voice_mode_disabled" });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json(400, { error: "empty_text" });
  if (text.length > MAX_TEXT_CHARS) {
    return json(413, {
      error: "text_too_long",
      limit: MAX_TEXT_CHARS,
      got: text.length,
    });
  }

  const provider = normalizeProvider(process.env.LUMO_TTS_PROVIDER);
  const deepgramApiKey = process.env.LUMO_DEEPGRAM_API_KEY;
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  if (provider === "deepgram" && !deepgramApiKey) {
    // Graceful fallback signal — client reads this and flips to
    // speechSynthesis for the rest of the session.
    return json(503, { reason: "tts_not_configured" });
  }
  if (provider === "elevenlabs" && !elevenLabsApiKey) {
    return json(503, { reason: "tts_legacy_not_configured" });
  }

  // Pull live config from admin_settings. The body's voice_id wins
  // (lets the user pick a different voice in /memory's voice picker
  // without changing the global default for everyone), then admin
  // setting, then compile-time fallback.
  const adminVoiceId = await getSetting<string>(
    "voice.voice_id",
    DEFAULT_VOICE_ID,
  );
  const modelId = await getSetting<string>("voice.model", DEFAULT_MODEL_ID);
  const stability = await getSetting<number>(
    "voice.stability",
    DEFAULT_STABILITY,
  );
  const similarityBoost = await getSetting<number>(
    "voice.similarity_boost",
    DEFAULT_SIMILARITY,
  );
  const style = await getSetting<number>("voice.style", DEFAULT_STYLE);
  const emotion = parseEmotion(body.emotion) ?? inferVoiceEmotion(text);
  const authedUser = await getServerUser().catch(() => null);
  const sessionId =
    typeof body.session_id === "string" && body.session_id.trim()
      ? body.session_id.trim()
      : null;

  const voiceId =
    typeof body.voice_id === "string" && body.voice_id.length > 0
      ? body.voice_id
      : adminVoiceId;

  const providerErrors: Array<{ provider: string; status?: number; reason: string }> = [];

  if (provider === "deepgram" && deepgramApiKey) {
    const voice = normalizeDeepgramVoice(voiceId || modelId);
    const startedAt = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(deepgramSpeakRestUrl(voice), {
        method: "POST",
        headers: {
          authorization: `Token ${deepgramApiKey}`,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.error("[tts] network error reaching Deepgram:", err);
      providerErrors.push({ provider: "deepgram", reason: "network_error" });
      void recordVoiceProviderCompare({
        provider: "deepgram",
        direction: "tts",
        total_audio_ms: Date.now() - startedAt,
        error: "network_error",
        session_id: sessionId,
        user_id: authedUser?.id ?? null,
      });
      upstream = null as unknown as Response;
    }

    if (upstream?.ok && upstream.body) {
      return audio(
        instrumentAudioStream(upstream.body, {
          provider: "deepgram",
          direction: "tts",
          startedAt,
          session_id: sessionId,
          user_id: authedUser?.id ?? null,
        }),
        "deepgram",
        emotion,
      );
    }

    if (upstream) {
      const errBody = await safeText(upstream);
      console.error(
        "[tts] Deepgram upstream error:",
        upstream.status,
        errBody.slice(0, 500),
      );
      providerErrors.push({
        provider: "deepgram",
        status: upstream.status,
        reason: upstream.status === 401 ? "auth_failed" : "upstream_error",
      });
      void recordVoiceProviderCompare({
        provider: "deepgram",
        direction: "tts",
        total_audio_ms: Date.now() - startedAt,
        error: upstream.status === 401 ? "auth_failed" : "upstream_error",
        session_id: sessionId,
        user_id: authedUser?.id ?? null,
      });
    }
  }

  if (provider === "elevenlabs" && elevenLabsApiKey) {
    const legacyVoiceId =
      typeof voiceId === "string" && voiceId.length > 0
        ? voiceId
        : LEGACY_ELEVENLABS_VOICE_ID;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      legacyVoiceId,
    )}/stream?output_format=mp3_44100_128`;

    const startedAt = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": elevenLabsApiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: modelId || LEGACY_ELEVENLABS_MODEL_ID,
          // Live from admin_settings. Defaults are the "warm friend"
          // baseline (stability 0.42, similarity 0.80, style 0.55) but
          // an operator can retune from /admin/settings without a
          // deploy. Settings cache is 30s so changes propagate fast.
          voice_settings: {
            ...tuneVoiceForEmotion(
              {
                stability,
                similarity_boost: similarityBoost,
                style,
              },
              emotion,
            ),
            use_speaker_boost: true,
          },
        }),
      });
    } catch (err) {
      console.error("[tts] network error reaching legacy TTS provider:", err);
      providerErrors.push({ provider: "elevenlabs", reason: "network_error" });
      void recordVoiceProviderCompare({
        provider: "elevenlabs",
        direction: "tts",
        total_audio_ms: Date.now() - startedAt,
        error: "network_error",
        session_id: sessionId,
        user_id: authedUser?.id ?? null,
      });
      upstream = null as unknown as Response;
    }

    if (upstream?.ok && upstream.body) {
      return audio(
        instrumentAudioStream(upstream.body, {
          provider: "elevenlabs",
          direction: "tts",
          startedAt,
          session_id: sessionId,
          user_id: authedUser?.id ?? null,
        }),
        "elevenlabs",
        emotion,
      );
    }

    if (upstream) {
      const errBody = await safeText(upstream);
      console.error(
        "[tts] legacy TTS upstream error:",
        upstream.status,
        errBody.slice(0, 500),
      );
      providerErrors.push({
        provider: "elevenlabs",
        status: upstream.status,
        reason: upstream.status === 401 ? "auth_failed" : "upstream_error",
      });
      void recordVoiceProviderCompare({
        provider: "elevenlabs",
        direction: "tts",
        total_audio_ms: Date.now() - startedAt,
        error: upstream.status === 401 ? "auth_failed" : "upstream_error",
        session_id: sessionId,
        user_id: authedUser?.id ?? null,
      });
    }
  }

  const hasConfiguredProvider = provider === "deepgram" ? Boolean(deepgramApiKey) : Boolean(elevenLabsApiKey);
  return json(hasConfiguredProvider ? 502 : 503, {
    reason: hasConfiguredProvider
      ? "tts_providers_unavailable"
      : "tts_not_configured",
    providers: providerErrors,
  });
}

function audio(
  body: ReadableStream<Uint8Array>,
  provider: string,
  emotion: VoiceEmotion,
): Response {
  // Stream the upstream MP3 body straight through to the client.
  // No buffering — first audio chunk lands in the browser as soon
  // as the provider emits it.
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      "x-lumo-tts-provider": provider,
      "x-lumo-tts-emotion": emotion,
      // Advertise streaming so fetch doesn't buffer.
      "transfer-encoding": "chunked",
    },
  });
}

function normalizeProvider(value: unknown): "deepgram" | "elevenlabs" {
  return typeof value === "string" && value.toLowerCase() === "elevenlabs"
    ? "elevenlabs"
    : "deepgram";
}

function parseEmotion(value: unknown): VoiceEmotion | null {
  return value === "neutral" ||
    value === "warm" ||
    value === "reassuring" ||
    value === "excited" ||
    value === "celebratory"
    ? value
    : null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
