export interface TranscribeAudioInput {
  audio_url: string;
  language?: string;
  speaker_diarization?: boolean;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

export interface TranscribeAudioResult {
  status: "ok" | "not_configured" | "error";
  transcript: string;
  segments: TranscriptSegment[];
  language: string | null;
  duration_s: number;
  model: string;
  diarization: "not_requested" | "ok" | "not_configured" | "error";
  source: "ml" | "fallback";
  latency_ms: number;
  error?: string;
}

interface TranscribeResponseBody {
  status?: unknown;
  transcript?: unknown;
  segments?: unknown;
  language?: unknown;
  duration_s?: unknown;
  model?: unknown;
  diarization?: unknown;
  _lumo_summary?: unknown;
}

export async function transcribeAudioCore(args: {
  input: TranscribeAudioInput;
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<TranscribeAudioResult> {
  const started = Date.now();
  const fallback = (
    error: string,
    status: "not_configured" | "error" = "error",
  ): TranscribeAudioResult => ({
    status,
    transcript: "",
    segments: [],
    language: args.input.language ?? null,
    duration_s: 0,
    model: "whisper-large-v3",
    diarization: args.input.speaker_diarization ? "not_configured" : "not_requested",
    source: "fallback" as const,
    latency_ms: Date.now() - started,
    error,
  });

  if (!args.baseUrl || !args.authorizationHeader) {
    return fallback("ml_transcribe_not_configured", "not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/transcribe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: args.authorizationHeader,
      },
      body: JSON.stringify(args.input),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const error_code = `http_${res.status}`;
      await args.recordUsage(false, error_code, latency_ms);
      return fallback(error_code);
    }

    const body = (await res.json()) as TranscribeResponseBody;
    const normalized = normalizeTranscribeResponse(body, latency_ms);
    if (!normalized) {
      await args.recordUsage(false, "malformed_response", latency_ms);
      return fallback("malformed_response");
    }
    await args.recordUsage(normalized.status === "ok", normalized.error, latency_ms);
    return normalized;
  } catch (err) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    const error_code =
      err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error";
    await args.recordUsage(false, error_code, latency_ms);
    return fallback(error_code);
  }
}

export function normalizeTranscribeResponse(
  body: TranscribeResponseBody,
  latency_ms = 0,
): TranscribeAudioResult | null {
  const status =
    body.status === "ok" || body.status === "not_configured" || body.status === "error"
      ? body.status
      : null;
  if (!status) return null;
  const transcript = typeof body.transcript === "string" ? body.transcript : "";
  const segments = normalizeSegments(body.segments);
  const language = typeof body.language === "string" ? body.language : null;
  const duration_s = finiteNumber(body.duration_s);
  const model = typeof body.model === "string" && body.model ? body.model : "whisper-large-v3";
  const diarization = normalizeDiarization(body.diarization, segments);
  return {
    status,
    transcript,
    segments,
    language,
    duration_s,
    model,
    diarization,
    source: "ml",
    latency_ms,
    error: status === "ok" ? undefined : status,
  };
}

function normalizeSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const out: TranscriptSegment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const start = finiteNumber(item.start);
    const end = Math.max(start, finiteNumber(item.end));
    const speaker = typeof item.speaker === "string" ? item.speaker : null;
    out.push({ start, end, text, speaker });
  }
  return out;
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeDiarization(
  value: unknown,
  segments: TranscriptSegment[],
): TranscribeAudioResult["diarization"] {
  if (
    value === "not_requested" ||
    value === "ok" ||
    value === "not_configured" ||
    value === "error"
  ) {
    return value;
  }
  return segments.some((segment) => segment.speaker) ? "ok" : "not_requested";
}
