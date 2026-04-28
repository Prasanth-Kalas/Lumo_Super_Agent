/**
 * GET /api/admin/intelligence/endpoints — per-endpoint last-24h
 * summary: request count, error rate, p50/p95/p99 latency, current
 * circuit-breaker state, last-seen timestamp.
 *
 * The circuit-breaker fields come from SDK-1's in-process breaker state
 * once that lands; until then we infer state from the recent error
 * rate (>5% for the last 5 minutes opens, between 3-5% half-open). The
 * fixture path mirrors the live aggregation so swapping is just one
 * edit when SDK-1 publishes a `brain_breaker_state` table or RPC.
 *
 * Server-side only. No raw rows leave the function.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { getSupabase } from "@/lib/db";
import {
  type EndpointSummary,
  type EndpointSummaryResponse,
} from "@/lib/admin/intelligence-api";
import { fixtureEndpointSummary } from "@/lib/admin/intelligence-fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BrainCallLogRow {
  endpoint: string;
  outcome: string;
  latency_ms: number;
  created_at: string;
}

export async function GET(_req: NextRequest) {
  const user = await requireServerUser();
  if (!isAdmin(user.email ?? null)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(fixtureEndpointSummary(), {
      headers: { "cache-control": "no-store" },
    });
  }

  try {
    const summary = await aggregateEndpointSummary(sb);
    if (summary.endpoints.length === 0) {
      return NextResponse.json(fixtureEndpointSummary(), {
        headers: { "cache-control": "no-store" },
      });
    }
    return NextResponse.json(summary, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    console.warn("[admin/intelligence/endpoints] falling back to fixtures:", e);
    return NextResponse.json(fixtureEndpointSummary(), {
      headers: { "cache-control": "no-store" },
    });
  }
}

async function aggregateEndpointSummary(
  sb: NonNullable<ReturnType<typeof getSupabase>>,
): Promise<EndpointSummaryResponse> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Pull only the columns we aggregate. Cap at 50k to bound memory; for
  // a real production table we'd push this aggregation server-side as
  // a Postgres function or a pre-summarized rollup.
  const { data, error } = await sb
    .from("brain_call_log")
    .select("endpoint, outcome, latency_ms, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50_000);

  if (error) throw error;

  const rows = (data ?? []) as BrainCallLogRow[];
  const byEndpoint = new Map<
    string,
    {
      requests: number;
      errors: number;
      latencies: number[];
      lastSeen: string | null;
      recent5mErrors: number;
      recent5mTotal: number;
    }
  >();

  const fiveMinAgo = Date.now() - 5 * 60 * 1000;

  for (const row of rows) {
    let bucket = byEndpoint.get(row.endpoint);
    if (!bucket) {
      bucket = {
        requests: 0,
        errors: 0,
        latencies: [],
        lastSeen: null,
        recent5mErrors: 0,
        recent5mTotal: 0,
      };
      byEndpoint.set(row.endpoint, bucket);
    }
    bucket.requests += 1;
    bucket.latencies.push(row.latency_ms);
    if (row.outcome !== "ok") bucket.errors += 1;
    if (!bucket.lastSeen || row.created_at > bucket.lastSeen) {
      bucket.lastSeen = row.created_at;
    }
    if (new Date(row.created_at).getTime() >= fiveMinAgo) {
      bucket.recent5mTotal += 1;
      if (row.outcome !== "ok") bucket.recent5mErrors += 1;
    }
  }

  const endpoints: EndpointSummary[] = Array.from(byEndpoint.entries()).map(
    ([ep, b]) => {
      const sorted = b.latencies.slice().sort((a, c) => a - c);
      const errRate = b.requests > 0 ? b.errors / b.requests : 0;
      const recent5mRate =
        b.recent5mTotal > 0 ? b.recent5mErrors / b.recent5mTotal : 0;
      const state: "open" | "half_open" | "closed" =
        recent5mRate > 0.05
          ? "open"
          : recent5mRate > 0.03
            ? "half_open"
            : "closed";
      return {
        endpoint: ep,
        requests_24h: b.requests,
        errors_24h: b.errors,
        error_rate_24h: errRate,
        latency_p50_ms: percentile(sorted, 0.5),
        latency_p95_ms: percentile(sorted, 0.95),
        latency_p99_ms: percentile(sorted, 0.99),
        circuit_breaker: {
          endpoint: ep,
          state,
          consecutive_failures: state === "closed" ? 0 : b.recent5mErrors,
          opened_at:
            state === "open"
              ? new Date(Date.now() - 60_000).toISOString()
              : null,
          half_open_probe_at:
            state === "half_open"
              ? new Date(Date.now() - 30_000).toISOString()
              : null,
        },
        last_seen_at: b.lastSeen,
      };
    },
  );

  endpoints.sort((a, b) => b.requests_24h - a.requests_24h);

  return { endpoints, is_fixture: false };
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * sortedAsc.length)),
  );
  return Math.round(sortedAsc[idx] ?? 0);
}
