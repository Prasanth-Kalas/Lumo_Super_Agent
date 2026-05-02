/**
 * POST /api/stt — app-owned speech-to-text fallback for VoiceMode.
 *
 * Deepgram Nova-3 is the cloud STT provider. VoiceMode records a short
 * WebM/MP4 clip with MediaRecorder, posts it here, and receives a transcript.
 * Realtime clients should use /api/audio/deepgram-token and Deepgram's
 * listen WebSocket directly; this route remains the recorded-audio fallback.
 */

import type { NextRequest } from "next/server";
import { AuthError, requireServerUser } from "@/lib/auth";
import { deepgramListenRestUrl, DEEPGRAM_STT_MODEL } from "@/lib/deepgram";
import { recordVoiceProviderCompare } from "@/lib/voice-provider-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
]);

export async function POST(req: NextRequest): Promise<Response> {
  let user;
  try {
    user = await requireServerUser();
  } catch (err) {
    if (err instanceof AuthError) {
      return json(
        { error: err.code },
        err.code === "not_authenticated" ? 401 : 403,
      );
    }
    throw err;
  }

  const apiKey = process.env.LUMO_DEEPGRAM_API_KEY;
  if (!apiKey) {
    return json({ error: "stt_not_configured" }, 503);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid_form_data" }, 400);
  }

  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    return json({ error: "missing_audio" }, 400);
  }
  if (audio.size <= 0) {
    return json({ error: "empty_audio" }, 400);
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return json(
      { error: "audio_too_large", limit: MAX_AUDIO_BYTES, got: audio.size },
      413,
    );
  }
  if (audio.type && !SUPPORTED_AUDIO_TYPES.has(audio.type)) {
    return json({ error: "unsupported_audio_type", type: audio.type }, 415);
  }

  const language = normalizeLanguage(form.get("language"));
  const startedAt = Date.now();
  const audioBuffer = await audio.arrayBuffer();
  let upstream: Response;
  try {
    upstream = await fetch(deepgramListenRestUrl({ language }), {
      method: "POST",
      headers: {
        authorization: `Token ${apiKey}`,
        "content-type": audio.type || "application/octet-stream",
      },
      body: audioBuffer,
    });
  } catch (err) {
    console.error("[stt] Deepgram transcription network error:", err);
    void recordVoiceProviderCompare({
      provider: "deepgram",
      direction: "stt",
      total_audio_ms: Date.now() - startedAt,
      audio_bytes: audio.size,
      error: "network_error",
      user_id: user.id,
    });
    return json({ error: "stt_upstream_network_error" }, 502);
  }

  if (!upstream.ok) {
    const detail = await safeText(upstream);
    console.error(
      "[stt] Deepgram transcription error:",
      upstream.status,
      detail.slice(0, 500),
    );
    void recordVoiceProviderCompare({
      provider: "deepgram",
      direction: "stt",
      total_audio_ms: Date.now() - startedAt,
      audio_bytes: audio.size,
      error: upstream.status === 401 ? "auth_failed" : "upstream_error",
      user_id: user.id,
    });
    return json(
      {
        error: "stt_upstream_error",
        status: upstream.status,
      },
      502,
    );
  }

  const data = (await upstream.json().catch(() => null)) as {
    metadata?: { duration?: unknown };
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: unknown }>;
      }>;
    };
  } | null;
  const transcript =
    typeof data?.results?.channels?.[0]?.alternatives?.[0]?.transcript === "string"
      ? data.results.channels[0].alternatives[0].transcript.trim()
      : "";
  const durationRaw = Number(data?.metadata?.duration);
  void recordVoiceProviderCompare({
    provider: "deepgram",
    direction: "stt",
    latency_first_token_ms: Date.now() - startedAt,
    total_audio_ms: Date.now() - startedAt,
    audio_bytes: audio.size,
    error: transcript ? null : "empty_transcript",
    user_id: user.id,
  });

  return json(
    {
      ok: true,
      transcript,
      language,
      duration_s: Number.isFinite(durationRaw) && durationRaw >= 0 ? durationRaw : null,
      model: DEEPGRAM_STT_MODEL,
    },
    200,
  );
}

function normalizeLanguage(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z]{2}(-[a-z]{2})?$/.test(normalized) ? normalized : null;
}

function json(body: unknown, status: number): Response {
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
