/**
 * Typed client + shared types for the /admin/intelligence dashboard.
 *
 * Two endpoints, both server-side aggregated:
 *   GET /api/admin/intelligence/timeseries
 *   GET /api/admin/intelligence/endpoints
 *
 * Codex's SDK-1 will eventually populate `brain_call_log`; until then
 * the routes return deterministic fixtures so the dashboard ships
 * useful UI from day one. The is_fixture flag in every payload lets
 * the UI render a subtle "demo data" badge.
 */

export type TimeRange = "1h" | "24h" | "7d" | "30d";

export interface TimeseriesBucket {
  /** ISO 8601 timestamp at the start of the bucket. */
  ts: string;
  requests: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  /** Count per error_class within this bucket. */
  error_breakdown: Record<string, number>;
}

export interface TimeseriesResponse {
  range: TimeRange;
  endpoint: string; // "all" or a specific brain endpoint name
  bucket_seconds: number;
  buckets: TimeseriesBucket[];
  is_fixture: boolean;
}

export interface CircuitBreakerSnapshot {
  endpoint: string;
  state: "closed" | "half_open" | "open";
  consecutive_failures: number;
  opened_at: string | null;
  half_open_probe_at: string | null;
}

export interface EndpointSummary {
  endpoint: string;
  requests_24h: number;
  errors_24h: number;
  error_rate_24h: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
  circuit_breaker: CircuitBreakerSnapshot;
  last_seen_at: string | null;
}

export interface EndpointSummaryResponse {
  endpoints: EndpointSummary[];
  is_fixture: boolean;
}

export interface ErrorClassBreakdown {
  error_class: string;
  count_24h: number;
}

export interface ErrorSample {
  id: string;
  ts: string;
  attempt: number;
  latency_ms: number;
  error_class: string;
  message: string;
  user_hash: string;
}

export interface SlowRequestSample {
  id: string;
  ts: string;
  attempt: number;
  latency_ms: number;
  outcome: string;
  user_hash: string;
}

export const TIME_RANGES: ReadonlyArray<{ value: TimeRange; label: string }> = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export const DEFAULT_RANGE: TimeRange = "24h";

// ──────────────────────────────────────────────────────────────────────────
// Client functions — used by the dashboard pages.
// ──────────────────────────────────────────────────────────────────────────

interface FetchOpts {
  signal?: AbortSignal;
}

export async function fetchTimeseries(
  range: TimeRange,
  endpoint: string = "all",
  opts: FetchOpts = {},
): Promise<TimeseriesResponse> {
  const url = `/api/admin/intelligence/timeseries?range=${encodeURIComponent(
    range,
  )}&endpoint=${encodeURIComponent(endpoint)}`;
  const res = await fetch(url, { cache: "no-store", signal: opts.signal });
  if (!res.ok) {
    throw new Error(`timeseries fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as TimeseriesResponse;
}

export async function fetchEndpointSummary(
  opts: FetchOpts = {},
): Promise<EndpointSummaryResponse> {
  const res = await fetch(`/api/admin/intelligence/endpoints`, {
    cache: "no-store",
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`endpoints fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as EndpointSummaryResponse;
}

// ──────────────────────────────────────────────────────────────────────────
// Format helpers — kept here so charts and tables share one source.
// ──────────────────────────────────────────────────────────────────────────

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  if (rate < 0.001) return "0.0%";
  if (rate < 0.01) return `${(rate * 100).toFixed(2)}%`;
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatBucketTs(ts: string, range: TimeRange): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  if (range === "1h" || range === "24h") {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
