"use client";

/**
 * ThroughputCard — headline number (requests / minute right now) plus
 * a lightweight sparkline of the last N buckets for trend.
 *
 * The headline is computed from the most recent two buckets so the
 * number doesn't look quiet during a partial bucket. The sparkline is
 * built from the same series the latency chart consumes — no extra
 * round-trip.
 */

import { useMemo } from "react";
import type {
  TimeRange,
  TimeseriesBucket,
} from "@/lib/admin/intelligence-api";
import { formatCount } from "@/lib/admin/intelligence-api";
import { ChartFrame } from "./ChartChrome";

interface Props {
  buckets: TimeseriesBucket[];
  bucketSeconds: number;
  range: TimeRange;
  isFixture?: boolean;
}

export function ThroughputCard({
  buckets,
  bucketSeconds,
  isFixture,
}: Props) {
  const { perMinute, totalRequests, totalErrors, sparkPath, max } = useMemo(() => {
    const recent = buckets.slice(-Math.max(2, Math.ceil(120 / bucketSeconds)));
    const reqs = recent.reduce((s, b) => s + b.requests, 0);
    const totalReqs = buckets.reduce((s, b) => s + b.requests, 0);
    const totalErrs = buckets.reduce((s, b) => s + b.errors, 0);
    const perMin =
      recent.length === 0
        ? 0
        : (reqs / Math.max(1, recent.length)) * (60 / bucketSeconds);
    const m = Math.max(1, ...buckets.map((b) => b.requests));

    const w = 200;
    const h = 36;
    const stepX = w / Math.max(1, buckets.length - 1);
    const path = buckets
      .map((b, i) => {
        const x = i * stepX;
        const y = h - (b.requests / m) * h;
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
    return {
      perMinute: perMin,
      totalRequests: totalReqs,
      totalErrors: totalErrs,
      sparkPath: path,
      max: m,
    };
  }, [buckets, bucketSeconds]);

  return (
    <ChartFrame
      title="Throughput"
      subtitle="Requests per minute (recent) · totals for window"
      isFixture={isFixture}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
        <div className="space-y-1">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
            Now
          </div>
          <div className="text-[28px] font-semibold tracking-tight text-lumo-fg num">
            {perMinute < 1 ? perMinute.toFixed(2) : Math.round(perMinute)}
            <span className="text-[14px] text-lumo-fg-mid font-normal num">
              {" "}
              req/min
            </span>
          </div>
          <dl className="text-[12px] text-lumo-fg-mid grid grid-cols-2 gap-x-3 gap-y-0.5 max-w-[260px]">
            <dt>Window total</dt>
            <dd className="num text-right">{formatCount(totalRequests)}</dd>
            <dt>Errors</dt>
            <dd className="num text-right">{formatCount(totalErrors)}</dd>
            <dt>Peak bucket</dt>
            <dd className="num text-right">{formatCount(max)}</dd>
          </dl>
        </div>
        <div>
          <svg
            role="img"
            aria-label={`Throughput sparkline, peak ${formatCount(max)} requests per bucket`}
            viewBox="0 0 200 36"
            className="w-full h-9 text-emerald-400"
          >
            <path d={sparkPath} fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <div className="mt-1 text-[10.5px] text-lumo-fg-low">
            Each tick = 1 bucket ({bucketSeconds}s)
          </div>
        </div>
      </div>
    </ChartFrame>
  );
}
