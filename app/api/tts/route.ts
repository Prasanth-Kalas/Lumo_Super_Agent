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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
// Reverted from "eleven_v3" — v3's variable first-chunk latency
// plus occasional mid-stream artifacts made the voice feel
// rushed and broken. Turbo v2.5 is our stable ground truth.
//   - "eleven_v3"         — experimental, richer prosody but
//                           inconsistent streaming. Revisit later.
//   - "eleven_flash_v2_5" — 75 ms, flatter delivery.
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
        // Voice settings retuned for "friend-like" warmth on turbo
        // v2.5. Prior settings (stability 0.5, style 0.3) were
        // safe but read as polite-concierge. Users want
        // conversational — someone you'd actually call.
        //
        //   stability 0.42 — slight drop from 0.5 lets the cadence
        //     breathe. Below 0.4 this model starts slurring;
        //     0.42-0.45 is the sweet spot for turbo v2.5 where
        //     prosody opens up without losing pace.
        //   similarity_boost 0.80 — bumped from 0.75 to hold the
        //     voice identity (Rachel) even as stability drops.
        //     Without this pairing, the voice drifts character
        //     across long responses.
        //   style 0.55 — real emotional inference. The model picks
        //     up punctuation cues (em-dashes, ellipses, question
        //     marks) and leans into them. Above 0.7 it starts
        //     over-acting; 0.55 is warm-but-honest.
        //   use_speaker_boost — keeps clarity on phone + laptop
        //     speakers where mids get muddy.
        voice_settings: {
          stability: 0.42,
          similarity_boost: 0.8,
          style: 0.55,
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
