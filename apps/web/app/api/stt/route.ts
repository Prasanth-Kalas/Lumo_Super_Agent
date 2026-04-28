/**
 * POST /api/stt — app-owned speech-to-text fallback for VoiceMode.
 *
 * Browser Web Speech is convenient but brittle: Chrome/Safari proxy
 * recognition through a browser speech service, and that service can
 * return `network` even when the user's internet and our app are fine.
 * This route is the fallback path. VoiceMode records a short WebM/MP4
 * clip with MediaRecorder, posts it here, and receives a transcript.
 */

import type { NextRequest } from "next/server";
import { AuthError, requireServerUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const DEFAULT_STT_MODEL = "whisper-1";
const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
]);

export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requireServerUser();
  } catch (err) {
    if (err instanceof AuthError) {
      return json(
        { error: err.code },
        err.code === "not_authenticated" ? 401 : 403,
      );
    }
    throw err;
  }

  const apiKey = process.env.OPENAI_API_KEY;
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
  const outbound = new FormData();
  outbound.set(
    "file",
    audio,
    audio.name || `lumo-voice.${extensionForType(audio.type)}`,
  );
  outbound.set("model", process.env.OPENAI_STT_MODEL || DEFAULT_STT_MODEL);
  outbound.set("response_format", "json");
  if (language) outbound.set("language", language);

  let upstream: Response;
  try {
    upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      body: outbound,
    });
  } catch (err) {
    console.error("[stt] OpenAI transcription network error:", err);
    return json({ error: "stt_upstream_network_error" }, 502);
  }

  if (!upstream.ok) {
    const detail = await safeText(upstream);
    console.error(
      "[stt] OpenAI transcription error:",
      upstream.status,
      detail.slice(0, 500),
    );
    return json(
      {
        error: "stt_upstream_error",
        status: upstream.status,
      },
      upstream.status === 401 ? 502 : 502,
    );
  }

  const data = (await upstream.json().catch(() => null)) as {
    text?: unknown;
    language?: unknown;
    duration?: unknown;
  } | null;
  const transcript = typeof data?.text === "string" ? data.text.trim() : "";

  return json(
    {
      ok: true,
      transcript,
      language: typeof data?.language === "string" ? data.language : language,
      duration_s:
        typeof data?.duration === "number" && Number.isFinite(data.duration)
          ? data.duration
          : null,
      model: process.env.OPENAI_STT_MODEL || DEFAULT_STT_MODEL,
    },
    200,
  );
}

function normalizeLanguage(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z]{2}(-[a-z]{2})?$/.test(normalized) ? normalized : null;
}

function extensionForType(type: string): string {
  switch (type) {
    case "audio/mp4":
      return "m4a";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
    default:
      return "webm";
  }
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
