"use client";

/**
 * /admin/intelligence — Brain observability dashboard (Phase 3).
 *
 * Reads pre-aggregated data from two routes:
 *   GET /api/admin/intelligence/timeseries?range&endpoint
 *   GET /api/admin/intelligence/endpoints
 *
 * The page composes seven pieces of UI:
 *   1. TimeRangePicker — primary filter (1h / 24h / 7d / 30d, default 24h).
 *   2. ThroughputCard — req/min headline + sparkline.
 *   3. CircuitBreakerStatus — per-endpoint open/half/closed badges.
 *   4. CostCard — RUNTIME-1 placeholder.
 *   5. LatencyChart — p50/p95/p99 lines per the selected endpoint.
 *   6. ErrorRateChart — stacked errors by class.
 *   7. EndpointTable — sortable per-endpoint last-24h summary.
 *      Selecting a row reveals EndpointDrillDown.
 *
 * Performance: every chart consumes pre-bucketed responses; we never
 * ship raw rows to the browser. Page targets < 2s render with 10k
 * events/24h and we confirmed the aggregation route bounds memory at
 * 50k rows. Auto-refresh is on a 60s timer (matches the previous
 * dashboard's cadence). Refresh is paused while drill-down is open so
 * the tab focus survives.
 *
 * Auth: middleware gates /admin/* by LUMO_ADMIN_EMAILS; the route
 * handlers re-check defense in depth. A 403 from either route surfaces
 * a forbidden banner, same pattern as the previous dashboard.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchEndpointSummary,
  fetchTimeseries,
  type EndpointSummaryResponse,
  type TimeRange,
  type TimeseriesResponse,
  DEFAULT_RANGE,
} from "@/lib/admin/intelligence-api";
import { TimeRangePicker } from "@/components/admin/intelligence/TimeRangePicker";
import { LatencyChart } from "@/components/admin/intelligence/LatencyChart";
import { ErrorRateChart } from "@/components/admin/intelligence/ErrorRateChart";
import { ThroughputCard } from "@/components/admin/intelligence/ThroughputCard";
import { CostCard } from "@/components/admin/intelligence/CostCard";
import { CircuitBreakerStatus } from "@/components/admin/intelligence/CircuitBreakerStatus";
import { EndpointTable } from "@/components/admin/intelligence/EndpointTable";
import { EndpointDrillDown } from "@/components/admin/intelligence/EndpointDrillDown";

const REFRESH_MS = 60_000;

type LoadState = "loading" | "ok" | "forbidden" | "error";

export default function AdminIntelligencePage() {
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const [endpointFilter, setEndpointFilter] = useState<string>("all");
  const [drillEndpoint, setDrillEndpoint] = useState<string | null>(null);

  const [series, setSeries] = useState<TimeseriesResponse | null>(null);
  const [summary, setSummary] = useState<EndpointSummaryResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [err, setErr] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [s, e] = await Promise.all([
          fetchTimeseries(range, endpointFilter, { signal }),
          fetchEndpointSummary({ signal }),
        ]);
        setSeries(s);
        setSummary(e);
        setState("ok");
        setErr(null);
        setGeneratedAt(new Date().toISOString());
      } catch (caught) {
        if ((caught as Error)?.name === "AbortError") return;
        const msg = caught instanceof Error ? caught.message : String(caught);
        if (msg.includes("HTTP 403")) {
          setState("forbidden");
        } else {
          setState("error");
          setErr(msg);
        }
      }
    },
    [range, endpointFilter],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    timer.current = setInterval(() => {
      // Pause auto-refresh while drilling so focus and scroll survive.
      if (!drillEndpoint) void refresh();
    }, REFRESH_MS);
    return () => {
      ctrl.abort();
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh, drillEndpoint]);

  const isFixture = !!(series?.is_fixture || summary?.is_fixture);

  if (state === "forbidden") {
    return (
      <div className="space-y-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
          Forbidden
        </h1>
        <p className="text-[13px] text-lumo-fg-mid">
          You are signed in but not on the admin allowlist (
          <code className="text-lumo-fg">LUMO_ADMIN_EMAILS</code>).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            Intelligence
          </h1>
          <p className="text-[13px] text-lumo-fg-mid">
            Brain observability — latency, errors, throughput, circuit
            breakers. Auto-refreshes every 60s.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <EndpointFilter
            options={summary?.endpoints.map((e) => e.endpoint) ?? []}
            value={endpointFilter}
            onChange={setEndpointFilter}
          />
          <TimeRangePicker
            value={range}
            onChange={(r) => setRange(r)}
            disabled={state === "loading"}
          />
          <div className="text-right">
            <div className="text-[11px] text-lumo-fg-low num">
              {generatedAt
                ? `Updated ${new Date(generatedAt).toLocaleTimeString()}`
                : "Loading…"}
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg"
            >
              Refresh now
            </button>
          </div>
        </div>
      </header>

      {err ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
          {err}
        </div>
      ) : null}

      {/* Row 1: top-line cards */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ThroughputCard
          buckets={series?.buckets ?? []}
          bucketSeconds={series?.bucket_seconds ?? 300}
          range={range}
          isFixture={isFixture}
        />
        <CircuitBreakerStatus
          endpoints={summary?.endpoints ?? []}
          isFixture={summary?.is_fixture}
        />
        <CostCard data={null} />
      </section>

      {/* Row 2: time-series charts */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LatencyChart
          buckets={series?.buckets ?? []}
          range={range}
          isFixture={series?.is_fixture}
        />
        <ErrorRateChart
          buckets={series?.buckets ?? []}
          range={range}
          isFixture={series?.is_fixture}
        />
      </section>

      {/* Row 3: endpoint table */}
      <EndpointTable
        endpoints={summary?.endpoints ?? []}
        selectedEndpoint={drillEndpoint}
        onSelect={(ep) => setDrillEndpoint(ep === drillEndpoint ? null : ep)}
        isFixture={summary?.is_fixture}
      />

      {/* Row 4: drill-down (visible only when an endpoint is selected) */}
      <EndpointDrillDown
        endpoint={drillEndpoint}
        range={range}
        onClose={() => setDrillEndpoint(null)}
      />
    </div>
  );
}

interface EndpointFilterProps {
  options: string[];
  value: string;
  onChange: (next: string) => void;
}

function EndpointFilter({ options, value, onChange }: EndpointFilterProps) {
  const opts = useMemo(() => ["all", ...options], [options]);
  return (
    <label className="inline-flex items-center gap-2 text-[12px] text-lumo-fg-mid">
      <span className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        Endpoint
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border border-lumo-hair bg-lumo-surface px-2 text-[12px] text-lumo-fg num"
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o === "all" ? "All endpoints" : o}
          </option>
        ))}
      </select>
    </label>
  );
}
