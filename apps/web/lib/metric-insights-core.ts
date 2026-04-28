import type {
  AnomalyDetectionResult,
  DetectAnomalyInput,
  MetricPointInput,
} from "./anomaly-detection-core.js";
import type { ForecastMetricResult } from "./forecasting-core.js";

export interface MetricInsightResult {
  answer: string;
  metric_key: string;
  anomaly: AnomalyDetectionResult;
  forecast: ForecastMetricResult | null;
}

export interface MetricInsightDeps {
  detectMetricAnomalies: (args: {
    user_id: string;
    input: DetectAnomalyInput;
    fetchImpl?: typeof fetch;
  }) => Promise<AnomalyDetectionResult>;
  forecastMetricForUser: (args: {
    user_id: string;
    input: {
      metric_key: string;
      points: MetricPointInput[];
      horizon_days: number;
      context?: { expected_frequency?: "daily" | "hourly" | "weekly" };
    };
    fetchImpl?: typeof fetch;
  }) => Promise<ForecastMetricResult>;
}

export function shouldRunMetricInsight(text: string): boolean {
  const lower = text.toLowerCase();
  const metricSignal = /\b(revenue|sales|stripe|bookings?|views?|followers?|engagement|conversion|price|pricing)\b/.test(lower);
  const questionSignal = /\b(why|down|drop|dropped|spike|anomal|forecast|predict|trend|going up|going down)\b/.test(lower);
  return metricSignal && questionSignal;
}

export async function answerMetricInsightCore(args: {
  user_id: string;
  query: string;
  deps: MetricInsightDeps;
  fetchImpl?: typeof fetch;
}): Promise<MetricInsightResult> {
  const metric_key = inferMetricKey(args.query);
  const points = buildStubMetricSeries(metric_key, args.query);
  const anomalyInput: DetectAnomalyInput = {
    metric_key,
    points,
    context: { expected_frequency: "daily", min_points: 14 },
  };
  const anomaly = await args.deps.detectMetricAnomalies({
    user_id: args.user_id,
    input: anomalyInput,
    fetchImpl: args.fetchImpl,
  });
  const wantsForecast = /\b(forecast|predict|next|will|going up|going down|price)\b/i.test(args.query);
  const forecast = wantsForecast
    ? await args.deps.forecastMetricForUser({
        user_id: args.user_id,
        input: {
          metric_key,
          points,
          horizon_days: 7,
          context: { expected_frequency: "daily" },
        },
        fetchImpl: args.fetchImpl,
      })
    : null;

  return {
    answer: formatMetricInsightAnswer(metric_key, anomaly, forecast),
    metric_key,
    anomaly,
    forecast,
  };
}

export function formatMetricInsightAnswer(
  metric_key: string,
  anomaly: AnomalyDetectionResult,
  forecast: ForecastMetricResult | null,
): string {
  const top = anomaly.findings[0];
  const label = labelForMetric(metric_key);
  const lines: string[] = [];
  if (top) {
    const direction =
      top.finding_type === "drop"
        ? "dropped"
        : top.finding_type === "spike"
          ? "spiked"
          : "changed";
    lines.push(
      `${label} ${direction} on ${formatDate(top.anomaly_ts)}: actual ${formatNumber(top.actual_value)} vs expected ${formatNumber(top.expected_value)}.`,
    );
    lines.push(
      `Confidence ${Math.round(top.confidence * 100)}% with z-score ${formatNumber(top.z_score)}.`,
    );
  } else {
    lines.push(`I did not find a high-confidence anomaly in ${label}.`);
  }
  if (forecast?.forecast.length) {
    const next = forecast.forecast[0]!;
    lines.push(
      `Next forecast point: ${formatNumber(next.predicted_value)} (${formatNumber(next.lower_bound)}-${formatNumber(next.upper_bound)} range).`,
    );
  }
  lines.push("I used Lumo's proactive analytics path; live connector metrics can replace this stub stream as they land.");
  return lines.join(" ");
}

function inferMetricKey(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("stripe") || lower.includes("revenue") || lower.includes("sales")) {
    return "stripe.revenue";
  }
  if (lower.includes("booking") || lower.includes("price")) return "travel.booking_price";
  if (lower.includes("view")) return "content.views";
  if (lower.includes("engagement")) return "content.engagement";
  return "workspace.metric";
}

function buildStubMetricSeries(metric_key: string, query: string): MetricPointInput[] {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29);
  const lower = query.toLowerCase();
  const dropOnLast = /\b(down|drop|dropped|lower|declin)/.test(lower);
  const spikeOnLast = /\b(spike|up|higher|surge)\b/.test(lower) && !dropOnLast;
  return Array.from({ length: 30 }, (_, index) => {
    const weekly = (index % 7) * 18;
    const trend = index * 2;
    let value = baseForMetric(metric_key) + weekly + trend;
    if (index === 29 && dropOnLast) value *= 0.55;
    if (index === 29 && spikeOnLast) value *= 1.6;
    return {
      ts: new Date(start + index * 24 * 60 * 60 * 1000).toISOString(),
      value: Math.round(value * 100) / 100,
      dimensions: { source: "stub" },
    };
  });
}

function baseForMetric(metric_key: string): number {
  if (metric_key === "stripe.revenue") return 1200;
  if (metric_key === "travel.booking_price") return 320;
  if (metric_key === "content.views") return 8000;
  return 100;
}

function labelForMetric(metric_key: string): string {
  if (metric_key === "stripe.revenue") return "Stripe revenue";
  if (metric_key === "travel.booking_price") return "Travel pricing";
  if (metric_key === "content.views") return "Content views";
  if (metric_key === "content.engagement") return "Content engagement";
  return metric_key;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0";
}
