/**
 * POST /api/tts — premium text-to-speech proxy.
 *
 * Request body:  { text: string, voice_id?: string }
 * Response:
 *   200 audio/mpeg  — streamed MP3 audio, pipe straight into <audio>.
 *   503 json        — { reason: "elevenlabs_not_configured" } when
 *                     the ELEVENLABS_API_KEY env isn't set. The client
 *                     falls back to browser speechSynthesis.
 *   502 json        — upstream ElevenLabs failure.
 *
 * Why proxy instead of calling ElevenLabs from the browser:
 *   - API key stays server-side. ElevenLabs tokens are usage-metered
 *     and we're not shipping them to every browser.
 *   - Rate-limiting + per-user throttling (TODO) can happen here.
 *   - Lets us swap providers later without touching the client —
 *     ElevenLabs today, OpenAI Realtime (Phase 3) tomorrow.
 *
 * Streaming: Upstream's /stream endpoint sends MP3 chunks as they
 * come out of the TTS model. We pipe `upstream.body` directly as
 * our ReadableStream — no buffering, no parsing. First byte in the
 * user's browser lands ~275ms after we start the request (Turbo
 * v2.5 model latency).
 *
 * Voice default: Rachel (21m00Tcm4TlvDq8ikWAM) — warm, professional
 * American female. Picked because it's the best all-rounder for a
 * concierge tone: authoritative enough for "your flight is booked",
 * friendly enough for "I found three options". Overridable per-call
 * via `voice_id` in the body.
 *
 * Model: eleven_turbo_v2_5 — reverted from the eleven_v3 trial
 * after users reported the v3 output was rushed and breaking up
 * mid-stream. Turbo v2.5 has a proven ~275 ms first-chunk latency
 * and very consistent prosody. If we want to re-trial v3 later,
 * flip the MODEL_ID constant back. Flash v2.5 (75 ms) is the
 * other one-liner if latency ever becomes more important than
 * expressiveness — the flatter delivery is the tradeoff.
 */

import type { NextRequest } from "next/server";
import { getSetting, isFeatureEnabled } from "@/lib/admin-settings";
import {
  inferVoiceEmotion,
  openAiEmotionInstructions,
  tuneVoiceForEmotion,
  type VoiceEmotion,
} from "@/lib/voice-emotion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Compile-time fallbacks. Admin-settings overrides win at runtime;
// these are what the route uses if the DB is unreachable or the
// settings rows are missing.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
const DEFAULT_STABILITY = 0.42;
const DEFAULT_SIMILARITY = 0.8;
const DEFAULT_STYLE = 0.55;
const DEFAULT_OPENAI_MODEL_ID = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_VOICE = "cedar";
const OPENAI_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
]);

// Hard caps so a runaway turn doesn't burn through the ElevenLabs
// character quota. Speech at ~150wpm ≈ 13 chars/sec, so 5000 chars
// is roughly a 6-minute monologue — longer than any reasonable
// concierge turn should be.
const MAX_TEXT_CHARS = 5000;

interface Body {
  text?: string;
  voice_id?: string;
  emotion?: VoiceEmotion;
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

  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (!elevenLabsApiKey && !openAiApiKey) {
    // Graceful fallback signal — client reads this and flips to
    // speechSynthesis for the rest of the session.
    return json(503, { reason: "tts_not_configured" });
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

  const voiceId =
    typeof body.voice_id === "string" && body.voice_id.length > 0
      ? body.voice_id
      : adminVoiceId;

  const providerErrors: Array<{ provider: string; status?: number; reason: string }> = [];

  if (elevenLabsApiKey) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId,
    )}/stream?output_format=mp3_44100_128`;

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
          model_id: modelId,
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
      console.error("[tts] network error reaching ElevenLabs:", err);
      providerErrors.push({ provider: "elevenlabs", reason: "network_error" });
      upstream = null as unknown as Response;
    }

    if (upstream?.ok && upstream.body) {
      return audio(upstream.body, "elevenlabs", emotion);
    }

    if (upstream) {
      const errBody = await safeText(upstream);
      console.error(
        "[tts] ElevenLabs upstream error:",
        upstream.status,
        errBody.slice(0, 500),
      );
      providerErrors.push({
        provider: "elevenlabs",
        status: upstream.status,
        reason: upstream.status === 401 ? "auth_failed" : "upstream_error",
      });
    }
  }

  if (openAiApiKey) {
    const openAiModel =
      process.env.OPENAI_TTS_MODEL?.trim() || DEFAULT_OPENAI_MODEL_ID;
    const openAiVoice = pickOpenAiVoice(body.voice_id);
    let upstream: Response;
    try {
      upstream = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          authorization: `Bearer ${openAiApiKey}`,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          model: openAiModel,
          voice: openAiVoice,
          input: text,
          response_format: "mp3",
          ...(openAiModel.startsWith("gpt-4o")
            ? {
                instructions: openAiEmotionInstructions(emotion),
              }
            : {}),
        }),
      });
    } catch (err) {
      console.error("[tts] network error reaching OpenAI TTS:", err);
      providerErrors.push({ provider: "openai", reason: "network_error" });
      upstream = null as unknown as Response;
    }

    if (upstream?.ok && upstream.body) {
      return audio(upstream.body, "openai", emotion);
    }

    if (upstream) {
      const errBody = await safeText(upstream);
      console.error(
        "[tts] OpenAI TTS upstream error:",
        upstream.status,
        errBody.slice(0, 500),
      );
      providerErrors.push({
        provider: "openai",
        status: upstream.status,
        reason: upstream.status === 401 ? "auth_failed" : "upstream_error",
      });
    }
  }

  const hasConfiguredProvider = Boolean(elevenLabsApiKey || openAiApiKey);
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

function parseEmotion(value: unknown): VoiceEmotion | null {
  return value === "neutral" ||
    value === "warm" ||
    value === "reassuring" ||
    value === "excited" ||
    value === "celebratory"
    ? value
    : null;
}

function pickOpenAiVoice(requested: unknown): string {
  if (typeof requested === "string" && OPENAI_VOICES.has(requested)) {
    return requested;
  }
  const envVoice = process.env.OPENAI_TTS_VOICE?.trim();
  if (envVoice && OPENAI_VOICES.has(envVoice)) return envVoice;
  return DEFAULT_OPENAI_VOICE;
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
