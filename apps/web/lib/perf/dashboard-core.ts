import {
  AGENT_TIMING_PHASES,
  type AgentTimingBucket,
  type AgentTimingPhase,
} from "./timing-spans.ts";
import {
  getPlanCompareStats,
  type PlanCompareStats,
} from "../admin-stats-core.ts";

export interface PerfStatRow {
  key: string;
  label: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface PerfSlowTurn {
  requestId: string;
  bucket: AgentTimingBucket;
  startedAt: string;
  totalMs: number;
  spans: Array<{
    phase: AgentTimingPhase;
    durationMs: number;
    metadata: Record<string, unknown>;
  }>;
}

export interface PerfTrendPoint {
  hour: string;
  count: number;
  p50Ms: number;
}

export interface AdminPerfDashboard {
  generatedAt: string;
  phaseStats24h: PerfStatRow[];
  bucketStats24h: PerfStatRow[];
  slowTurns: PerfSlowTurn[];
  totalTrend7d: PerfTrendPoint[];
  planCompareStats: PlanCompareStats;
}

export interface TimingRow {
  request_id: string;
  phase: AgentTimingPhase;
  bucket: AgentTimingBucket;
  started_at: string;
  duration_ms: number;
  metadata: Record<string, unknown> | null;
}

export function buildAdminPerfDashboardFromRows(
  rawRows: TimingRow[],
  generatedAt = new Date().toISOString(),
  rawPlanCompareRows: unknown[] = [],
): AdminPerfDashboard {
  const rows = rawRows.filter((row) => AGENT_TIMING_PHASES.includes(row.phase));
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows24h = rows.filter((row) => row.started_at >= since24h);
  const totalRows24h = rows24h.filter((row) => row.phase === "total");

  return {
    generatedAt,
    phaseStats24h: buildPhaseStats(rows24h),
    bucketStats24h: buildBucketStats(totalRows24h),
    slowTurns: buildSlowTurns(rows24h),
    totalTrend7d: buildTrend(rows),
    planCompareStats: getPlanCompareStats(rawPlanCompareRows),
  };
}

function buildPhaseStats(rows: TimingRow[]): PerfStatRow[] {
  const groups = new Map<AgentTimingPhase, number[]>();
  for (const phase of AGENT_TIMING_PHASES) groups.set(phase, []);
  for (const row of rows) groups.get(row.phase)?.push(row.duration_ms);
  return Array.from(groups.entries()).map(([phase, values]) =>
    statRow(phase, labelForPhase(phase), values),
  );
}

function buildBucketStats(rows: TimingRow[]): PerfStatRow[] {
  const groups = new Map<AgentTimingBucket, number[]>([
    ["fast_path", []],
    ["tool_path", []],
    ["reasoning_path", []],
  ]);
  for (const row of rows) groups.get(row.bucket)?.push(row.duration_ms);
  return Array.from(groups.entries()).map(([bucket, values]) =>
    statRow(bucket, labelForBucket(bucket), values),
  );
}

function buildSlowTurns(rows: TimingRow[]): PerfSlowTurn[] {
  const byRequest = new Map<string, TimingRow[]>();
  for (const row of rows) {
    const entries = byRequest.get(row.request_id) ?? [];
    entries.push(row);
    byRequest.set(row.request_id, entries);
  }
  return Array.from(byRequest.entries())
    .map(([requestId, spans]) => {
      const total = spans.find((span) => span.phase === "total");
      if (!total) return null;
      return {
        requestId,
        bucket: total.bucket,
        startedAt: total.started_at,
        totalMs: total.duration_ms,
        spans: spans
          .filter((span) => span.phase !== "total")
          .sort((a, b) => a.started_at.localeCompare(b.started_at))
          .map((span) => ({
            phase: span.phase,
            durationMs: span.duration_ms,
            metadata: span.metadata ?? {},
          })),
      };
    })
    .filter((entry): entry is PerfSlowTurn => entry !== null)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 20);
}

function buildTrend(rows: TimingRow[]): PerfTrendPoint[] {
  const byHour = new Map<string, number[]>();
  for (const row of rows) {
    if (row.phase !== "total") continue;
    const hour = new Date(row.started_at);
    hour.setUTCMinutes(0, 0, 0);
    const key = hour.toISOString();
    const values = byHour.get(key) ?? [];
    values.push(row.duration_ms);
    byHour.set(key, values);
  }
  return Array.from(byHour.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, values]) => ({
      hour,
      count: values.length,
      p50Ms: percentile(values, 0.5),
    }));
}

function statRow(key: string, label: string, values: number[]): PerfStatRow {
  return {
    key,
    label,
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return Math.max(0, sorted[idx] ?? 0);
}

function labelForPhase(phase: AgentTimingPhase): string {
  return phase
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function labelForBucket(bucket: AgentTimingBucket): string {
  if (bucket === "fast_path") return "Fast path";
  if (bucket === "tool_path") return "Tool path";
  return "Reasoning path";
}
