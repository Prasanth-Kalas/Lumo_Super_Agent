import { deepgramSpeakRestUrl } from "./deepgram.ts";
import { recordVoiceProviderCompare } from "./voice-provider-compare.ts";

const DEEPGRAM_RETRY_BACKOFF_MS = 200;

export interface DeepgramSpeechRetryArgs {
  apiKey: string;
  voice: string;
  text: string;
  sessionId: string | null;
  userId: string | null;
  startedAt: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
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
  sessionId,
  userId,
  startedAt,
  fetchImpl = fetch,
  sleepImpl = sleep,
}: DeepgramSpeechRetryArgs): Promise<Response | null> {
  let lastResponse: Response | null = null;
  let lastNetworkError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      const response = await fetchImpl(deepgramSpeakRestUrl(voice), {
        method: "POST",
        headers: {
          authorization: `Token ${apiKey}`,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text }),
      });
      lastResponse = response;
      if (response.ok || !isRetryableDeepgramStatus(response.status) || attempt === 2) {
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
      lastNetworkError = error;
      if (attempt === 2) {
        console.error("[tts] network error reaching Deepgram after retry:", error);
        void recordVoiceProviderCompare({
          provider: "deepgram",
          direction: "tts",
          total_audio_ms: Date.now() - startedAt,
          error: "network_error_attempt_2",
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
