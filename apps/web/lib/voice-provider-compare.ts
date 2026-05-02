import { getSupabase } from "./db.ts";

export type VoiceProvider = "deepgram" | "elevenlabs";
export type VoiceDirection = "stt" | "tts";

export interface VoiceProviderCompareInput {
  provider: VoiceProvider;
  direction: VoiceDirection;
  latency_first_token_ms?: number | null;
  total_audio_ms?: number | null;
  audio_bytes?: number | null;
  error?: string | null;
  session_id?: string | null;
  user_id?: string | null;
}

export function buildVoiceProviderCompareRow(input: VoiceProviderCompareInput) {
  return {
    provider: input.provider,
    direction: input.direction,
    latency_first_token_ms: nullableNonNegativeInt(input.latency_first_token_ms),
    total_audio_ms: nullableNonNegativeInt(input.total_audio_ms),
    audio_bytes: nullableNonNegativeInt(input.audio_bytes),
    error: sanitizeError(input.error),
    session_id: sanitizeSessionId(input.session_id),
    user_id: input.user_id ?? null,
  };
}

export async function recordVoiceProviderCompare(
  input: VoiceProviderCompareInput,
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from("voice_provider_compare").insert(
    buildVoiceProviderCompareRow(input),
  );
  if (error) {
    console.warn("[voice-provider-compare] insert failed", error.message);
  }
}

export function instrumentAudioStream(
  body: ReadableStream<Uint8Array>,
  args: Omit<VoiceProviderCompareInput, "latency_first_token_ms" | "total_audio_ms" | "audio_bytes" | "error"> & {
    startedAt: number;
  },
): ReadableStream<Uint8Array> {
  let firstChunkAt: number | null = null;
  let bytes = 0;
  let recorded = false;
  const reader = body.getReader();
  const recordOnce = (error: string | null) => {
    if (recorded) return;
    recorded = true;
    const endedAt = Date.now();
    void recordVoiceProviderCompare({
      ...args,
      latency_first_token_ms:
        firstChunkAt === null ? null : Math.max(0, firstChunkAt - args.startedAt),
      total_audio_ms: Math.max(0, endedAt - args.startedAt),
      audio_bytes: bytes,
      error,
    });
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          recordOnce(null);
          controller.close();
          return;
        }
        if (value) {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          bytes += value.byteLength;
          controller.enqueue(value);
        }
      } catch (error) {
        recordOnce(error instanceof Error ? error.name : "stream_error");
        controller.error(error);
      }
    },
    async cancel(reason) {
      recordOnce(reason ? "stream_cancelled" : null);
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

function nullableNonNegativeInt(value: number | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function sanitizeError(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  return trimmed ? trimmed.slice(0, 240) : null;
}

function sanitizeSessionId(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, "_").trim().slice(0, 200);
  return compact || null;
}
