export interface EmbedImageInput {
  image_url: string;
  candidate_labels?: string[];
  source_metadata?: Record<string, unknown>;
}

export interface ImageLabel {
  label: string;
  score: number;
}

export interface EmbedImageResult {
  status: "ok" | "not_configured" | "error";
  model: string;
  dimensions: number;
  embedding: number[];
  labels: ImageLabel[];
  summary_text: string;
  content_hash: string;
  source: "ml" | "fallback";
  latency_ms: number;
  error?: string;
}

interface EmbedImageResponseBody {
  status?: unknown;
  model?: unknown;
  dimensions?: unknown;
  embedding?: unknown;
  labels?: unknown;
  summary_text?: unknown;
  content_hash?: unknown;
  _lumo_summary?: unknown;
}

const DEFAULT_MODEL = "openai/clip-vit-base-patch32";
const DEFAULT_DIMENSIONS = 512;

export async function embedImageCore(args: {
  input: EmbedImageInput;
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<EmbedImageResult> {
  const started = Date.now();
  const fallback = (error: string, status: "not_configured" | "error" = "error") => ({
    status,
    model: DEFAULT_MODEL,
    dimensions: DEFAULT_DIMENSIONS,
    embedding: [],
    labels: [],
    summary_text: "",
    content_hash: "",
    source: "fallback" as const,
    latency_ms: Date.now() - started,
    error,
  });

  if (!args.baseUrl || !args.authorizationHeader) {
    return fallback("ml_embed_image_not_configured", "not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/embed_image`, {
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

    const body = (await res.json()) as EmbedImageResponseBody;
    const normalized = normalizeEmbedImageResponse(body, latency_ms);
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

export function normalizeEmbedImageResponse(
  body: EmbedImageResponseBody,
  latency_ms = 0,
): EmbedImageResult | null {
  const status =
    body.status === "ok" || body.status === "not_configured" || body.status === "error"
      ? body.status
      : null;
  if (!status) return null;

  const embedding = normalizeEmbedding(body.embedding);
  const model = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
  const dimensions = finitePositiveInt(body.dimensions) || embedding.length || DEFAULT_DIMENSIONS;
  const labels = normalizeLabels(body.labels);
  const summary_text = typeof body.summary_text === "string" ? body.summary_text.trim() : "";
  const content_hash = typeof body.content_hash === "string" ? body.content_hash.trim() : "";

  if (status === "ok" && (embedding.length === 0 || !summary_text)) return null;

  return {
    status,
    model,
    dimensions,
    embedding,
    labels,
    summary_text,
    content_hash,
    source: "ml",
    latency_ms,
    error: status === "ok" ? undefined : status,
  };
}

function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isFinite(n)) return [];
    out.push(n);
  }
  return out;
}

function normalizeLabels(value: unknown): ImageLabel[] {
  if (!Array.isArray(value)) return [];
  const labels: ImageLabel[] = [];
  for (const raw of value.slice(0, 12)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!label) continue;
    const score = Number(item.score);
    labels.push({
      label: label.slice(0, 120),
      score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
    });
  }
  return labels;
}

function finitePositiveInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.trunc(n);
}
