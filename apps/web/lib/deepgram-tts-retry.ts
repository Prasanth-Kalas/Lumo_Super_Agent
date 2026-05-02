import { deepgramSpeakRestUrl } from "./deepgram.ts";
import { recordVoiceProviderCompare } from "./voice-provider-compare.ts";
import type { VoiceEmotion } from "./voice-emotion.ts";

const DEEPGRAM_RETRY_BACKOFF_MS = 200;
export const DEEPGRAM_TTS_MAX_ATTEMPTS = 3;
const DEEPGRAM_ATTEMPT_TIMEOUT_MS = 2500;

export interface DeepgramSpeechRetryArgs {
  apiKey: string;
  voice: string;
  text: string;
  speed: number;
  emotion: VoiceEmotion;
  sessionId: string | null;
  userId: string | null;
  startedAt: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  attemptTimeoutMs?: number;
}

export function isRetryableDeepgramStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

export function deepgramRequestId(response: Response | null): string | null {
  if (!response) return null;
  return (
    response.headers.get("dg-request-id") ??
    response.headers.get("x-dg-request-id") ??
    response.headers.get("request-id") ??
    response.headers.get("x-request-id")
  );
}

export async function fetchDeepgramSpeechWithRetry({
  apiKey,
  voice,
  text,
  speed,
  emotion,
  sessionId,
  userId,
  startedAt,
  fetchImpl = fetch,
  sleepImpl = sleep,
  attemptTimeoutMs = DEEPGRAM_ATTEMPT_TIMEOUT_MS,
}: DeepgramSpeechRetryArgs): Promise<Response | null> {
  let lastResponse: Response | null = null;
  let lastNetworkError: unknown = null;

  for (let attempt = 1; attempt <= DEEPGRAM_TTS_MAX_ATTEMPTS; attempt++) {
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(250, attemptTimeoutMs),
    );
    try {
      const response = await fetchImpl(deepgramSpeakRestUrl(voice, { speed }), {
        method: "POST",
        headers: {
          authorization: `Token ${apiKey}`,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        signal: controller.signal,
        body: JSON.stringify({ text }),
      });
      clearTimeout(timeout);
      lastResponse = response;
      const responseBodyPreview = response.ok
        ? null
        : await responseBodyPreviewText(response);
      logDeepgramAttempt({
        attempt,
        status: response.status,
        requestId: deepgramRequestId(response),
        bodyPreview: responseBodyPreview,
        elapsedMs: Date.now() - attemptStartedAt,
        textLength: text.length,
        voiceId: voice,
        emotion,
      });
      if (
        response.ok ||
        !isRetryableDeepgramStatus(response.status) ||
        attempt === DEEPGRAM_TTS_MAX_ATTEMPTS
      ) {
        return response;
      }
      console.warn("[tts] Deepgram transient failure; retrying", {
        attempt,
        status: response.status,
        deepgram_request_id: deepgramRequestId(response),
      });
      void recordVoiceProviderCompare({
        provider: "deepgram",
        direction: "tts",
        total_audio_ms: Date.now() - attemptStartedAt,
        error: `upstream_${response.status}_attempt_${attempt}`,
        session_id: sessionId,
        user_id: userId,
      });
    } catch (error) {
      clearTimeout(timeout);
      lastNetworkError = error;
      logDeepgramAttempt({
        attempt,
        status: null,
        requestId: null,
        bodyPreview: error instanceof Error ? error.name : "network_error",
        elapsedMs: Date.now() - attemptStartedAt,
        textLength: text.length,
        voiceId: voice,
        emotion,
      });
      if (attempt === DEEPGRAM_TTS_MAX_ATTEMPTS) {
        console.error("[tts] network error reaching Deepgram after retry:", error);
        void recordVoiceProviderCompare({
          provider: "deepgram",
          direction: "tts",
          total_audio_ms: Date.now() - startedAt,
          error: `network_error_attempt_${attempt}`,
          session_id: sessionId,
          user_id: userId,
        });
        return null;
      }
      console.warn("[tts] Deepgram network error; retrying", {
        attempt,
        error: error instanceof Error ? error.name : "network_error",
      });
      void recordVoiceProviderCompare({
        provider: "deepgram",
        direction: "tts",
        total_audio_ms: Date.now() - attemptStartedAt,
        error: `network_error_attempt_${attempt}`,
        session_id: sessionId,
        user_id: userId,
      });
    }
    await sleepImpl(DEEPGRAM_RETRY_BACKOFF_MS);
  }

  if (lastNetworkError) return null;
  return lastResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseBodyPreviewText(response: Response): Promise<string | null> {
  try {
    return (await response.clone().text()).slice(0, 300);
  } catch {
    return null;
  }
}

function logDeepgramAttempt(input: {
  attempt: number;
  status: number | null;
  requestId: string | null;
  bodyPreview: string | null;
  elapsedMs: number;
  textLength: number;
  voiceId: string;
  emotion: VoiceEmotion;
}): void {
  console.log(
    JSON.stringify({
      event: "tts_deepgram_attempt",
      attempt_number: input.attempt,
      status: input.status,
      deepgram_request_id: input.requestId,
      deepgram_response_body_preview: input.bodyPreview,
      elapsed_ms: Math.max(0, Math.round(input.elapsedMs)),
      text_length: input.textLength,
      voice_id: input.voiceId,
      emotion: input.emotion,
    }),
  );
}
