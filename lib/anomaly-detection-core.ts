export type AnomalySource = "ml" | "fallback";
export type AnomalyModel =
  | "prophet"
  | "isolation_forest"
  | "hybrid"
  | "seasonal_robust"
  | "dimension_pattern"
  | "hybrid_fallback"
  | "not_configured";
export type AnomalyFindingType = "spike" | "drop" | "level_shift" | "pattern_change";

export interface MetricPointInput {
  ts: string;
  value: number;
  dimensions?: Record<string, unknown>;
}

export interface DetectAnomalyInput {
  metric_key: string;
  points: MetricPointInput[];
  context?: {
    lookback_days?: number;
    expected_frequency?: "daily" | "hourly" | "weekly";
    min_points?: number;
  };
}

export interface AnomalyFinding {
  finding_type: AnomalyFindingType;
  anomaly_ts: string;
  expected_value: number;
  actual_value: number;
  z_score: number;
  confidence: number;
}

export interface AnomalyDetectionResult {
  findings: AnomalyFinding[];
  model: AnomalyModel;
  points_analyzed: number;
  source: AnomalySource;
  latency_ms: number;
  error?: string;
}

interface DetectAnomalyResponseBody {
  findings?: unknown;
  model?: unknown;
  model_detail?: unknown;
  points_analyzed?: unknown;
}

const ZSCORE_THRESHOLD = 3;

export async function detectAnomalyCore(args: {
  input: DetectAnomalyInput;
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<AnomalyDetectionResult> {
  const started = Date.now();
  const fallback = (error?: string) =>
    detectAnomalyFallback(args.input, Date.now() - started, error);

  if (!args.baseUrl || !args.authorizationHeader) {
    return fallback("ml_anomaly_not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/detect_anomaly`, {
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

    const body = (await res.json()) as DetectAnomalyResponseBody;
    const normalized = normalizeDetectAnomalyResponse(body, latency_ms);
    if (!normalized) {
      await args.recordUsage(false, "malformed_response", latency_ms);
      return fallback("malformed_response");
    }
    await args.recordUsage(true, undefined, latency_ms);
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

export function normalizeDetectAnomalyResponse(
  body: DetectAnomalyResponseBody,
  latency_ms = 0,
): AnomalyDetectionResult | null {
  const model = normalizeModel(body.model);
  if (!model) return null;
  const findings = normalizeFindings(body.findings);
  if (!Array.isArray(body.findings)) return null;
  const points_analyzed = finiteNumber(body.points_analyzed);
  return {
    findings,
    model,
    points_analyzed,
    source: "ml",
    latency_ms,
  };
}

export function detectAnomalyFallback(
  input: DetectAnomalyInput,
  latency_ms = 0,
  error?: string,
): AnomalyDetectionResult {
  const points = input.points
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const minPoints = clampInt(input.context?.min_points, 3, 1000, 14);
  if (points.length < minPoints) {
    return {
      findings: [],
      model: "not_configured",
      points_analyzed: points.length,
      source: "fallback",
      latency_ms,
      error,
    };
  }

  const findings: AnomalyFinding[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const baseline = points.filter((_, otherIndex) => otherIndex !== index).map((p) => p.value);
    const expected = median(baseline);
    const scale = robustScale(baseline.map((value) => value - expected)) || standardDeviation(baseline);
    if (scale <= 0) continue;
    const z = (point.value - expected) / scale;
    if (Math.abs(z) < ZSCORE_THRESHOLD) continue;
    findings.push({
      finding_type: z > 0 ? "spike" : "drop",
      anomaly_ts: point.ts,
      expected_value: round(expected),
      actual_value: round(point.value),
      z_score: round(z),
      confidence: round(Math.min(0.99, 1 - Math.exp(-Math.max(0, Math.abs(z) - 1.5) / 1.2))),
    });
  }

  findings.sort((a, b) => b.confidence - a.confidence);
  return {
    findings: findings.slice(0, 12).sort((a, b) => Date.parse(a.anomaly_ts) - Date.parse(b.anomaly_ts)),
    model: input.points.some((point) => point.dimensions && Object.keys(point.dimensions).length > 0)
      ? "hybrid_fallback"
      : "seasonal_robust",
    points_analyzed: points.length,
    source: "fallback",
    latency_ms,
    error,
  };
}

function normalizeFindings(value: unknown): AnomalyFinding[] {
  if (!Array.isArray(value)) return [];
  const out: AnomalyFinding[] = [];
  for (const raw of value.slice(0, 25)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const finding_type = normalizeFindingType(item.finding_type);
    const anomaly_ts = typeof item.anomaly_ts === "string" ? item.anomaly_ts : "";
    if (!finding_type || !Number.isFinite(Date.parse(anomaly_ts))) continue;
    out.push({
      finding_type,
      anomaly_ts,
      expected_value: finiteNumber(item.expected_value),
      actual_value: finiteNumber(item.actual_value),
      z_score: finiteNumber(item.z_score),
      confidence: clampNumber(finiteNumber(item.confidence), 0, 1),
    });
  }
  return out;
}

function normalizeModel(value: unknown): AnomalyModel | null {
  return value === "prophet" ||
    value === "isolation_forest" ||
    value === "hybrid" ||
    value === "seasonal_robust" ||
    value === "dimension_pattern" ||
    value === "hybrid_fallback" ||
    value === "not_configured"
    ? value
    : null;
}

function normalizeFindingType(value: unknown): AnomalyFindingType | null {
  return value === "spike" ||
    value === "drop" ||
    value === "level_shift" ||
    value === "pattern_change"
    ? value
    : null;
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(Number(value));
  return Math.min(max, Math.max(min, n));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function robustScale(values: number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return 1.4826 * median(values.map((value) => Math.abs(value - center)));
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
