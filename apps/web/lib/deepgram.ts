export const DEEPGRAM_AUTH_GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
export const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
export const DEEPGRAM_LISTEN_WS_URL = "wss://api.deepgram.com/v1/listen";
export const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
export const DEEPGRAM_SPEAK_WS_URL = "wss://api.deepgram.com/v1/speak";

export const DEEPGRAM_TOKEN_TTL_SECONDS = 60;
export const DEEPGRAM_TOKEN_REFRESH_SECONDS = 50;
export const DEEPGRAM_STT_MODEL = "nova-3";
export const DEFAULT_DEEPGRAM_TTS_VOICE = "aura-2-thalia-en";
export const SECONDARY_DEEPGRAM_TTS_VOICE = "aura-2-orpheus-en";
export const DEFAULT_DEEPGRAM_TTS_SPEED = 0.9;
export const MIN_DEEPGRAM_TTS_SPEED = 0.7;
export const MAX_DEEPGRAM_TTS_SPEED = 1.5;
export const DEEPGRAM_TTS_VOICES = new Set([
  DEFAULT_DEEPGRAM_TTS_VOICE,
  SECONDARY_DEEPGRAM_TTS_VOICE,
]);

export interface DeepgramTokenResult {
  token: string;
  expires_at: string;
  expires_in: number;
}

export interface CreateDeepgramTokenOptions {
  apiKey?: string | null;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export type DeepgramTokenResponse =
  | { ok: true; result: DeepgramTokenResult }
  | { ok: false; error: "deepgram_not_configured" | "deepgram_token_error"; status: number };

export async function createDeepgramTemporaryToken(
  options: CreateDeepgramTokenOptions = {},
): Promise<DeepgramTokenResponse> {
  const apiKey = options.apiKey ?? process.env.LUMO_DEEPGRAM_API_KEY ?? "";
  if (!apiKey.trim()) {
    return { ok: false, error: "deepgram_not_configured", status: 503 };
  }

  const ttlSeconds = clampInt(options.ttlSeconds, 1, 3600, DEEPGRAM_TOKEN_TTL_SECONDS);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  let response: Response;
  try {
    response = await fetchImpl(DEEPGRAM_AUTH_GRANT_URL, {
      method: "POST",
      headers: {
        authorization: `Token ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    });
  } catch {
    return { ok: false, error: "deepgram_token_error", status: 502 };
  }

  if (!response.ok) {
    return { ok: false, error: "deepgram_token_error", status: 502 };
  }

  const data = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  const token = typeof data?.access_token === "string" ? data.access_token.trim() : "";
  if (!token) {
    return { ok: false, error: "deepgram_token_error", status: 502 };
  }
  const expiresInRaw = Number(data?.expires_in);
  const expiresIn =
    Number.isFinite(expiresInRaw) && expiresInRaw > 0
      ? Math.floor(expiresInRaw)
      : ttlSeconds;
  const expiresAt = new Date(now().getTime() + expiresIn * 1000).toISOString();
  return {
    ok: true,
    result: {
      token,
      expires_at: expiresAt,
      expires_in: expiresIn,
    },
  };
}

export function deepgramListenWebSocketUrl(params: {
  sampleRate?: number;
  encoding?: "linear16";
  language?: string | null;
} = {}): string {
  const query = new URLSearchParams({
    model: DEEPGRAM_STT_MODEL,
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
  });
  if (params.encoding) {
    query.set("encoding", params.encoding);
    query.set("sample_rate", String(params.sampleRate ?? 16_000));
    query.set("channels", "1");
  }
  if (params.language) query.set("language", params.language);
  return `${DEEPGRAM_LISTEN_WS_URL}?${query.toString()}`;
}

export function deepgramListenRestUrl(params: { language?: string | null } = {}): string {
  const query = new URLSearchParams({
    model: DEEPGRAM_STT_MODEL,
    smart_format: "true",
  });
  if (params.language) query.set("language", params.language);
  return `${DEEPGRAM_LISTEN_URL}?${query.toString()}`;
}

export function deepgramSpeakRestUrl(
  voice: string,
  options: { speed?: number | string | null } = {},
): string {
  const query = new URLSearchParams({
    model: normalizeDeepgramVoice(voice),
    encoding: "mp3",
    speed: String(normalizeDeepgramTtsSpeed(options.speed)),
  });
  return `${DEEPGRAM_SPEAK_URL}?${query.toString()}`;
}

export function deepgramSpeakWebSocketUrl(voice: string): string {
  const query = new URLSearchParams({
    model: normalizeDeepgramVoice(voice),
    encoding: "linear16",
    sample_rate: "48000",
  });
  return `${DEEPGRAM_SPEAK_WS_URL}?${query.toString()}`;
}

export function normalizeDeepgramVoice(value: unknown): string {
  if (typeof value === "string" && DEEPGRAM_TTS_VOICES.has(value)) return value;
  return DEFAULT_DEEPGRAM_TTS_VOICE;
}

export function normalizeDeepgramTtsSpeed(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_DEEPGRAM_TTS_SPEED;
  }
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(String(value));
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_DEEPGRAM_TTS_SPEED ||
    parsed > MAX_DEEPGRAM_TTS_SPEED
  ) {
    return DEFAULT_DEEPGRAM_TTS_SPEED;
  }
  return Math.round(parsed * 100) / 100;
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
