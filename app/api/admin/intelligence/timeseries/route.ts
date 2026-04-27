/**
 * GET /api/admin/intelligence/timeseries — server-side aggregation
 * over `brain_call_log` (Codex's SDK-1 table).
 *
 * Query params:
 *   - range: "1h" | "24h" | "7d" | "30d" (default 24h)
 *   - endpoint: brain endpoint name, or "all" (default "all")
 *
 * Bucket sizing per the dashboard contract:
 *   1h  → 60s
 *   24h → 300s
 *   7d  → 3600s
 *   30d → 86400s
 *
 * The aggregation computes p50/p95/p99 per bucket plus per-bucket
 * error_class counts. Approximate quantiles are fine — we read pre-
 * sampled rows where available and fall back to in-process percentiles
 * when not. NEVER ship raw rows to the client; the page must render
 * from buckets only.
 *
 * Auth: same gate as every /admin/* surface — admin allowlist.
 *
 * If the table doesn't exist yet, or the window is empty, the route
 * falls back to lib/admin/intelligence-fixtures.ts so the dashboard
 * stays useful while SDK-1 is rolling out.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { getSupabase } from "@/lib/db";
import {
  type TimeRange,
  type TimeseriesBucket,
  type TimeseriesResponse,
} from "@/lib/admin/intelligence-api";
import {
  bucketSecondsForRange,
  bucketCountForRange,
  fixtureTimeseries,
  type FixtureEndpoint,
} from "@/lib/admin/intelligence-fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_RANGES: ReadonlyArray<TimeRange> = ["1h", "24h", "7d", "30d"];

function parseRange(raw: string | null): TimeRange {
  if (!raw) return "24h";
  return (VALID_RANGES as readonly string[]).includes(raw)
    ? (raw as TimeRange)
    : "24h";
}

export async function GET(req: NextRequest) {
  const user = await requireServerUser();
  if (!isAdmin(user.email ?? null)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range"));
  const endpoint = (url.searchParams.get("endpoint") ?? "all").trim() || "all";

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      fixtureTimeseries(range, endpoint as FixtureEndpoint | "all"),
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const payload = await aggregateTimeseries(sb, range, endpoint);
    if (payload.buckets.length === 0 || sumRequests(payload.buckets) === 0) {
      return NextResponse.json(
        fixtureTimeseries(range, endpoint as FixtureEndpoint | "all"),
        { headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(payload, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    // Most likely cause during build-out: brain_call_log doesn't exist
    // yet. Fall back to fixtures so the page is usable.
    console.warn("[admin/intelligence/timeseries] falling back to fixtures:", e);
    return NextResponse.json(
      fixtureTimeseries(range, endpoint as FixtureEndpoint | "all"),
      { headers: { "cache-control": "no-store" } },
    );
  }
}

function sumRequests(b: TimeseriesBucket[]): number {
  let s = 0;
  for (const r of b) s += r.requests;
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────────────────────────

interface BrainCallLogRow {
  endpoint: string;
  outcome: string;
  latency_ms: number;
  error_class: string | null;
  created_at: string;
}

async function aggregateTimeseries(
  sb: NonNullable<ReturnType<typeof getSupabase>>,
  range: TimeRange,
  endpoint: string,
): Promise<TimeseriesResponse> {
  const bucketSec = bucketSecondsForRange(range);
  const buckets = bucketCountForRange(range);
  const now = Date.now();
  const startMs = now - buckets * bucketSec * 1000;
  const since = new Date(startMs).toISOString();

  let query = sb
    .from("brain_call_log")
    .select("endpoint, outcome, latency_ms, error_class, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(50_000); // hard ceiling so we never blow memory; sized to budget

  if (endpoint !== "all") {
    query = query.eq("endpoint", endpoint);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as BrainCallLogRow[];

  // Build buckets keyed by index from window start.
  const slots: Array<{
    requests: number;
    errors: number;
    latencies: number[];
    errorBreakdown: Record<string, number>;
  }> = Array.from({ length: buckets }, () => ({
    requests: 0,
    errors: 0,
    latencies: [],
    errorBreakdown: {},
  }));

  for (const row of rows) {
    const t = new Date(row.created_at).getTime();
    const idx = Math.floor((t - startMs) / (bucketSec * 1000));
    if (idx < 0 || idx >= buckets) continue;
    const slot = slots[idx];
    if (!slot) continue;
    slot.requests += 1;
    slot.latencies.push(row.latency_ms);
    if (row.outcome !== "ok") {
      slot.errors += 1;
      const cls = row.error_class ?? "unknown";
      slot.errorBreakdown[cls] = (slot.errorBreakdown[cls] ?? 0) + 1;
    }
  }

  const out: TimeseriesBucket[] = slots.map((s, i) => {
    const ts = new Date(startMs + i * bucketSec * 1000).toISOString();
    const sorted = s.latencies.slice().sort((a, b) => a - b);
    return {
      ts,
      requests: s.requests,
      errors: s.errors,
      p50_ms: percentile(sorted, 0.5),
      p95_ms: percentile(sorted, 0.95),
      p99_ms: percentile(sorted, 0.99),
      error_breakdown: s.errorBreakdown,
    };
  });

  return {
    range,
    endpoint,
    bucket_seconds: bucketSec,
    buckets: out,
    is_fixture: false,
  };
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * sortedAsc.length)),
  );
  return Math.round(sortedAsc[idx] ?? 0);
}
