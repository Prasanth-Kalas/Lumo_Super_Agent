"use client";

/**
 * EndpointDrillDown — recent error samples + slow-request traces for a
 * specific brain endpoint.
 *
 * Reads the time-series for the selected endpoint and pulls the worst
 * buckets out for a quick "what went wrong?" view. Until SDK-1 ships
 * an `error_samples` projection, the page synthesises samples from
 * fixture data (clearly badged) so the layout exists end to end.
 */

import { useEffect, useState } from "react";
import {
  fetchTimeseries,
  formatLatency,
  type TimeRange,
} from "@/lib/admin/intelligence-api";
import {
  fixtureErrorSamples,
  fixtureSlowSamples,
} from "@/lib/admin/intelligence-fixtures";
import { ChartFrame, EmptyState } from "./ChartChrome";

interface Props {
  endpoint: string | null;
  range: TimeRange;
  onClose: () => void;
}

export function EndpointDrillDown({ endpoint, range, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [worstBuckets, setWorstBuckets] = useState<
    Array<{
      ts: string;
      requests: number;
      errors: number;
      p99_ms: number;
    }>
  >([]);

  useEffect(() => {
    if (!endpoint) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetchTimeseries(range, endpoint, { signal: ctrl.signal })
      .then((res) => {
        const top = res.buckets
          .slice()
          .sort((a, b) => b.errors - a.errors || b.p99_ms - a.p99_ms)
          .slice(0, 5)
          .map((b) => ({
            ts: b.ts,
            requests: b.requests,
            errors: b.errors,
            p99_ms: b.p99_ms,
          }));
        setWorstBuckets(top);
      })
      .catch(() => setWorstBuckets([]))
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [endpoint, range]);

  if (!endpoint) return null;

  // Until SDK-1 lands an error-samples projection, render fixture
  // samples but flag them clearly. Once Codex publishes
  // GET /api/admin/intelligence/samples?endpoint=… we'll wire that in.
  const errorSamples = fixtureErrorSamples(endpoint);
  const slowSamples = fixtureSlowSamples(endpoint);

  return (
    <ChartFrame
      title={`Drill-down · ${endpoint}`}
      subtitle="Worst buckets in the current window, plus recent error & slow samples"
      isFixture
      action={
        <button
          type="button"
          onClick={onClose}
          className="h-7 px-2.5 rounded-md border border-lumo-hair text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated"
        >
          Close
        </button>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2">
          <h3 className="text-[12px] uppercase tracking-[0.14em] text-lumo-fg-low">
            Worst buckets
          </h3>
          {loading ? (
            <div className="text-[12.5px] text-lumo-fg-mid">Loading…</div>
          ) : worstBuckets.length === 0 ? (
            <EmptyState>No buckets to surface.</EmptyState>
          ) : (
            <ul className="space-y-1.5">
              {worstBuckets.map((b) => (
                <li
                  key={b.ts}
                  className="rounded-md border border-lumo-hair bg-lumo-bg px-2.5 py-1.5 text-[11.5px]"
                >
                  <div className="flex justify-between text-lumo-fg num">
                    <span>{new Date(b.ts).toISOString().slice(11, 16)}Z</span>
                    <span>{formatLatency(b.p99_ms)}</span>
                  </div>
                  <div className="text-[10.5px] text-lumo-fg-low num">
                    {b.requests} reqs · {b.errors} errors
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-[12px] uppercase tracking-[0.14em] text-lumo-fg-low">
            Recent error samples
          </h3>
          <ul className="space-y-1.5">
            {errorSamples.map((e) => (
              <li
                key={e.id}
                className="rounded-md border border-lumo-hair bg-lumo-bg px-2.5 py-1.5 text-[11.5px]"
              >
                <div className="flex justify-between">
                  <span className="text-red-400 num">{e.error_class}</span>
                  <span className="text-lumo-fg-low num">
                    {formatLatency(e.latency_ms)}
                  </span>
                </div>
                <div className="text-[10.5px] text-lumo-fg-mid">{e.message}</div>
                <div className="text-[10px] text-lumo-fg-low num">
                  attempt {e.attempt} · {new Date(e.ts).toISOString().slice(11, 19)}Z
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <h3 className="text-[12px] uppercase tracking-[0.14em] text-lumo-fg-low">
            Slow-request traces
          </h3>
          <ul className="space-y-1.5">
            {slowSamples.slice(0, 6).map((s) => (
              <li
                key={s.id}
                className="rounded-md border border-lumo-hair bg-lumo-bg px-2.5 py-1.5 text-[11.5px]"
              >
                <div className="flex justify-between">
                  <span className="text-lumo-fg num">{s.outcome}</span>
                  <span className="text-amber-400 num">
                    {formatLatency(s.latency_ms)}
                  </span>
                </div>
                <div className="text-[10px] text-lumo-fg-low num">
                  {new Date(s.ts).toISOString().slice(11, 19)}Z · {s.user_hash}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-[11px] text-lumo-fg-low">
        Sample lists fall back to deterministic fixtures while SDK-1 finalises
        the <code className="text-lumo-fg-mid">brain_call_log</code>
        {" "}error-sample projection. Once that ships the samples here pull live
        rows.
      </p>
    </ChartFrame>
  );
}
