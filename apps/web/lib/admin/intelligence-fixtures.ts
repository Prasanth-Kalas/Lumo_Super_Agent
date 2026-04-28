/**
 * Synthetic fixtures for the /admin/intelligence dashboard.
 *
 * Codex's SDK-1 is shipping `brain_call_log` in parallel. Until the
 * table lands and starts collecting rows, the dashboard renders against
 * these deterministic fixtures. The route handlers fall back to this
 * module when the table is empty or absent so the page stays useful end
 * to end during Phase-3 build-out.
 *
 * Determinism matters here: the fixtures back UI snapshots, so a fixed
 * seed and a stable wall-clock anchor are deliberate. Real production
 * data replaces these once SDK-1 is emitting rows.
 *
 * The shape of every export matches what the API routes return — that
 * way the components don't know whether they're reading mock or live
 * data.
 */
import type {
  TimeRange,
  TimeseriesResponse,
  EndpointSummary,
  EndpointSummaryResponse,
  CircuitBreakerSnapshot,
  ErrorClassBreakdown,
  ErrorSample,
  SlowRequestSample,
} from "./intelligence-api";

const ENDPOINTS = [
  "lumo_recall",
  "lumo_classify",
  "lumo_marketplace_intelligence",
  "lumo_anomaly_detect",
  "lumo_forecast",
  "lumo_kg_traverse",
] as const;

export type FixtureEndpoint = (typeof ENDPOINTS)[number];

const ERROR_CLASSES = [
  "timeout",
  "rate_limited",
  "validation",
  "upstream_5xx",
  "auth",
] as const;

/**
 * Bucket size in seconds for each TimeRange. 1h → 60s, 24h → 300s,
 * 7d → 3600s, 30d → 86400s. Mirrors the contract shipped by the API
 * route so the UI never re-buckets client-side.
 */
export function bucketSecondsForRange(range: TimeRange): number {
  switch (range) {
    case "1h":
      return 60;
    case "24h":
      return 300;
    case "7d":
      return 3600;
    case "30d":
      return 86400;
  }
}

export function bucketCountForRange(range: TimeRange): number {
  switch (range) {
    case "1h":
      return 60;
    case "24h":
      return 288;
    case "7d":
      return 168;
    case "30d":
      return 30;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Deterministic pseudo-random — small LCG seeded from string + index.
// Avoids importing a dep just for fixture jitter.
// ──────────────────────────────────────────────────────────────────────────
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pseudoRandom(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Time-series fixture
// ──────────────────────────────────────────────────────────────────────────

export function fixtureTimeseries(
  range: TimeRange,
  endpoint: FixtureEndpoint | "all" = "all",
  anchorMs?: number,
): TimeseriesResponse {
  const bucketSec = bucketSecondsForRange(range);
  const buckets = bucketCountForRange(range);
  const now = anchorMs ?? Date.now();
  const startMs = now - buckets * bucketSec * 1000;
  const rand = pseudoRandom(hashSeed(`${range}:${endpoint}`));

  const rows = [];
  for (let i = 0; i < buckets; i++) {
    const ts = new Date(startMs + i * bucketSec * 1000).toISOString();
    // Diurnal: peak around index buckets*0.7 (early evening).
    const phase = (i / buckets) * Math.PI * 2;
    const diurnal = 1 + 0.6 * Math.sin(phase - 1.2);
    const base = endpoint === "all" ? 24 : 6;
    const requests = Math.max(
      0,
      Math.round(base * diurnal + rand() * 6 - 3),
    );

    // Latency: p50 around 220ms, p95 ~ 1.8x, p99 ~ 3.2x. Inject a slow
    // burst at ~70% through the window so slow-request UI has signal.
    const burst = i > buckets * 0.68 && i < buckets * 0.74 ? 2.4 : 1;
    const p50 = Math.round((180 + rand() * 80) * burst);
    const p95 = Math.round(p50 * (1.7 + rand() * 0.3));
    const p99 = Math.round(p95 * (1.5 + rand() * 0.4));

    // Error rate: usually < 1%, occasional spike with a clear class.
    const errSpike = rand() < 0.04 ? 1 : 0;
    const errors = Math.max(0, errSpike + (rand() < 0.08 ? 1 : 0));
    const errorBreakdown: Record<string, number> = {};
    if (errors > 0) {
      const cls =
        ERROR_CLASSES[Math.floor(rand() * ERROR_CLASSES.length)] ?? "unknown";
      errorBreakdown[cls] = errors;
    }

    rows.push({
      ts,
      requests,
      errors,
      p50_ms: p50,
      p95_ms: p95,
      p99_ms: p99,
      error_breakdown: errorBreakdown,
    });
  }

  return {
    range,
    endpoint,
    bucket_seconds: bucketSec,
    buckets: rows,
    is_fixture: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-endpoint summary fixture (24h)
// ──────────────────────────────────────────────────────────────────────────

export function fixtureEndpointSummary(): EndpointSummaryResponse {
  const rand = pseudoRandom(hashSeed("endpoints:24h"));
  const rows: EndpointSummary[] = ENDPOINTS.map((ep, i) => {
    const requests = 800 + Math.floor(rand() * 4200);
    const errorRate = i === 3 ? 0.038 : 0.001 + rand() * 0.012;
    const errors = Math.round(requests * errorRate);
    const p50 = Math.round(140 + rand() * 120);
    const p95 = Math.round(p50 * (1.7 + rand() * 0.4));
    const p99 = Math.round(p95 * (1.4 + rand() * 0.3));
    const breaker: CircuitBreakerSnapshot["state"] =
      errorRate > 0.03
        ? "half_open"
        : errorRate > 0.05
          ? "open"
          : "closed";
    return {
      endpoint: ep,
      requests_24h: requests,
      errors_24h: errors,
      error_rate_24h: errorRate,
      latency_p50_ms: p50,
      latency_p95_ms: p95,
      latency_p99_ms: p99,
      circuit_breaker: {
        endpoint: ep,
        state: breaker,
        consecutive_failures: breaker === "closed" ? 0 : 3 + i,
        opened_at:
          breaker === "open"
            ? new Date(Date.now() - 8 * 60_000).toISOString()
            : null,
        half_open_probe_at:
          breaker === "half_open"
            ? new Date(Date.now() - 30_000).toISOString()
            : null,
      },
      last_seen_at: new Date(Date.now() - Math.floor(rand() * 60_000)).toISOString(),
    };
  });

  return { endpoints: rows, is_fixture: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Drill-down: error samples + slow traces
// ──────────────────────────────────────────────────────────────────────────

export function fixtureErrorSamples(endpoint: string): ErrorSample[] {
  const rand = pseudoRandom(hashSeed(`errors:${endpoint}`));
  return Array.from({ length: 6 }).map((_, i) => {
    const cls =
      ERROR_CLASSES[Math.floor(rand() * ERROR_CLASSES.length)] ?? "unknown";
    return {
      id: `err_${endpoint.slice(0, 4)}_${i}`,
      ts: new Date(Date.now() - (i + 1) * 4 * 60_000).toISOString(),
      attempt: 1 + Math.floor(rand() * 3),
      latency_ms: 1500 + Math.floor(rand() * 12_000),
      error_class: cls,
      message: humanErrorMessage(cls),
      user_hash: `u_${Math.floor(rand() * 9999).toString(36)}`,
    };
  });
}

export function fixtureSlowSamples(endpoint: string): SlowRequestSample[] {
  const rand = pseudoRandom(hashSeed(`slow:${endpoint}`));
  return Array.from({ length: 8 }).map((_, i) => {
    return {
      id: `slow_${endpoint.slice(0, 4)}_${i}`,
      ts: new Date(Date.now() - (i + 1) * 2 * 60_000).toISOString(),
      attempt: 1,
      latency_ms: 1800 + Math.floor(rand() * 4500),
      outcome: "ok",
      user_hash: `u_${Math.floor(rand() * 9999).toString(36)}`,
    };
  });
}

export function fixtureErrorBreakdown(): ErrorClassBreakdown[] {
  return [
    { error_class: "timeout", count_24h: 184 },
    { error_class: "rate_limited", count_24h: 41 },
    { error_class: "upstream_5xx", count_24h: 27 },
    { error_class: "validation", count_24h: 12 },
    { error_class: "auth", count_24h: 3 },
  ];
}

function humanErrorMessage(cls: string): string {
  switch (cls) {
    case "timeout":
      return "deadline exceeded after 8000ms (no upstream response)";
    case "rate_limited":
      return "429 from upstream; retry-after: 30s";
    case "upstream_5xx":
      return "503 service unavailable from brain";
    case "validation":
      return "schema mismatch on response payload";
    case "auth":
      return "service JWT rejected; refresh in flight";
    default:
      return "unknown error";
  }
}

export const FIXTURE_ENDPOINTS = ENDPOINTS;
