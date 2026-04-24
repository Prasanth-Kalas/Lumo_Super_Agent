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
 * Model: eleven_turbo_v2_5 — best naturalness-to-latency ratio. We
 * don't use Flash v2.5 yet (75ms but slightly lower quality) — if
 * latency ends up mattering more than warmth, revisit.
 */

import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const MODEL_ID = "eleven_turbo_v2_5";

// Hard caps so a runaway turn doesn't burn through the ElevenLabs
// character quota. Speech at ~150wpm ≈ 13 chars/sec, so 5000 chars
// is roughly a 6-minute monologue — longer than any reasonable
// concierge turn should be.
const MAX_TEXT_CHARS = 5000;

interface Body {
  text?: string;
  voice_id?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    // Graceful fallback signal — client reads this and flips to
    // speechSynthesis for the rest of the session.
    return json(503, { reason: "elevenlabs_not_configured" });
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

  const voiceId =
    typeof body.voice_id === "string" && body.voice_id.length > 0
      ? body.voice_id
      : DEFAULT_VOICE_ID;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    voiceId,
  )}/stream?output_format=mp3_44100_128`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        // Voice settings retuned for naturalness (task #91). The prior
        // defaults (stability 0.5, style 0) produced a flat "narrator"
        // read — technically clean but felt like a bot.
        //
        //   stability 0.35 — lower = more pitch/pace variation. 0.35
        //     is the sweet spot for conversational speech; below 0.3
        //     starts sounding erratic.
        //   similarity_boost 0.85 — bumped to hold voice identity
        //     while the lower stability lets expression breathe.
        //   style 0.45 — was 0, which disables emotional inference
        //     entirely. 0.45 lets the model pick up cues from
        //     punctuation and context. Above 0.7 starts over-acting.
        //   use_speaker_boost — keeps clarity on small speakers.
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.85,
          style: 0.45,
          use_speaker_boost: true,
        },
      }),
    });
  } catch (err) {
    console.error("[tts] network error reaching ElevenLabs:", err);
    return json(502, { reason: "upstream_unreachable" });
  }

  if (!upstream.ok || !upstream.body) {
    const errBody = await safeText(upstream);
    console.error(
      "[tts] ElevenLabs upstream error:",
      upstream.status,
      errBody.slice(0, 500),
    );
    // 401 from upstream means the key is wrong — surface as 503
    // so the client treats it like "not configured" and falls
    // back cleanly without retrying on every chunk.
    if (upstream.status === 401) {
      return json(503, { reason: "elevenlabs_auth_failed" });
    }
    return json(502, {
      reason: "upstream_error",
      upstream_status: upstream.status,
    });
  }

  // Stream the upstream MP3 body straight through to the client.
  // No buffering — first audio chunk lands in the browser as soon
  // as ElevenLabs emits it.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      // Advertise streaming so fetch doesn't buffer.
      "transfer-encoding": "chunked",
    },
  });
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
