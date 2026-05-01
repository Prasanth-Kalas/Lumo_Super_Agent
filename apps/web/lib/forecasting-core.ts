import type {
  ForecastMetricResponse as MlForecastMetricResponse,
  ForecastPoint,
} from "@lumo/shared-types";
import type { MetricPointInput } from "./anomaly-detection-core.js";

// ForecastPoint and ForecastModel mirror the Pydantic source of truth in
// apps/ml-service/lumo_ml/schemas.py. Importing them from @lumo/shared-types
// is what guarantees the orchestrator and the ML service agree on the wire
// shape — CI runs a drift check on the codegen so a Pydantic change without a
// regenerated dist/ blocks the build.
export type { ForecastPoint };
export type ForecastSource = "ml" | "fallback";
export type ForecastModel = MlForecastMetricResponse["model"];

export interface ForecastMetricInput {
  metric_key: string;
  points: MetricPointInput[];
  horizon_days: number;
  context?: {
    expected_frequency?: "daily" | "hourly" | "weekly";
  };
}

export interface ForecastMetricResult {
  forecast: ForecastPoint[];
  model: ForecastModel;
  confidence_interval: number;
  points_used: number;
  source: ForecastSource;
  latency_ms: number;
  error?: string;
}

interface ForecastResponseBody {
  forecast?: unknown;
  model?: unknown;
  confidence_interval?: unknown;
  points_used?: unknown;
}

export async function forecastMetricCore(args: {
  input: ForecastMetricInput;
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<ForecastMetricResult> {
  const started = Date.now();
  const fallback = (error?: string) =>
    forecastMetricFallback(args.input, Date.now() - started, error);

  if (!args.baseUrl || !args.authorizationHeader) {
    return fallback("ml_forecast_not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/forecast_metric`, {
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
    const body = (await res.json()) as ForecastResponseBody;
    const normalized = normalizeForecastMetricResponse(body, latency_ms);
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

export function normalizeForecastMetricResponse(
  body: ForecastResponseBody,
  latency_ms = 0,
): ForecastMetricResult | null {
  const model = normalizeModel(body.model);
  if (!model || !Array.isArray(body.forecast)) return null;
  return {
    forecast: normalizeForecast(body.forecast),
    model,
    confidence_interval: clampNumber(finiteNumber(body.confidence_interval), 0, 1),
    points_used: Math.max(0, Math.trunc(finiteNumber(body.points_used))),
    source: "ml",
    latency_ms,
  };
}

export function forecastMetricFallback(
  input: ForecastMetricInput,
  latency_ms = 0,
  error?: string,
): ForecastMetricResult {
  const points = input.points
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (points.length < 2) {
    return {
      forecast: [],
      model: "not_configured",
      confidence_interval: 0.8,
      points_used: points.length,
      source: "fallback",
      latency_ms,
      error,
    };
  }

  const frequency = input.context?.expected_frequency ?? "daily";
  const periods = periodCount(input.horizon_days, frequency);
  const seasonalPeriod = seasonalPeriodFor(frequency);
  const stepMs = stepMsFor(frequency);
  const values = points.map((point) => point.value);
  const intervalScale = Math.max(residualScale(values, seasonalPeriod), standardDeviation(values) * 0.35, 0.01);
  const forecast: ForecastPoint[] = [];
  const lastTs = Date.parse(points.at(-1)!.ts);
  for (let offset = 1; offset <= periods; offset++) {
    const predicted = seasonalValue(values, seasonalPeriod, offset);
    const width = Math.max(intervalScale * 1.28155, Math.abs(predicted) * 0.02, 0.01);
    forecast.push({
      ts: new Date(lastTs + stepMs * offset).toISOString(),
      predicted_value: round(predicted),
      lower_bound: round(predicted - width),
      upper_bound: round(predicted + width),
    });
  }

  return {
    forecast,
    model: "naive_seasonal",
    confidence_interval: 0.8,
    points_used: points.length,
    source: "fallback",
    latency_ms,
    error,
  };
}

function normalizeForecast(value: unknown[]): ForecastPoint[] {
  const out: ForecastPoint[] = [];
  for (const raw of value.slice(0, 366)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const ts = typeof item.ts === "string" ? item.ts : "";
    if (!Number.isFinite(Date.parse(ts))) continue;
    const predicted = finiteNumber(item.predicted_value);
    const lower = finiteNumber(item.lower_bound);
    const upper = finiteNumber(item.upper_bound);
    out.push({
      ts,
      predicted_value: predicted,
      lower_bound: Math.min(lower, predicted),
      upper_bound: Math.max(upper, predicted),
    });
  }
  return out;
}

function normalizeModel(value: unknown): ForecastModel | null {
  return value === "prophet" || value === "naive_seasonal" || value === "not_configured"
    ? value
    : null;
}

function periodCount(horizonDays: number, frequency: string): number {
  const days = Math.min(365, Math.max(1, Math.trunc(horizonDays)));
  if (frequency === "hourly") return Math.min(days * 24, 24 * 31);
  if (frequency === "weekly") return Math.max(1, Math.ceil(days / 7));
  return days;
}

function seasonalPeriodFor(frequency: string): number {
  if (frequency === "hourly") return 24;
  if (frequency === "weekly") return 52;
  return 7;
}

function stepMsFor(frequency: string): number {
  if (frequency === "hourly") return 60 * 60 * 1000;
  if (frequency === "weekly") return 7 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function seasonalValue(values: number[], seasonalPeriod: number, offset: number): number {
  if (values.length >= seasonalPeriod) {
    return values[values.length - seasonalPeriod + ((offset - 1) % seasonalPeriod)] ?? values.at(-1) ?? 0;
  }
  return median(values);
}

function residualScale(values: number[], seasonalPeriod: number): number {
  if (values.length <= seasonalPeriod) return 0;
  const residuals = values.slice(seasonalPeriod).map((value, index) => value - values[index]!);
  const center = median(residuals);
  const mad = median(residuals.map((value) => Math.abs(value - center)));
  return 1.4826 * mad || standardDeviation(residuals);
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
