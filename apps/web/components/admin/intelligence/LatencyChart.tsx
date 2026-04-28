"use client";

/**
 * LatencyChart — p50 / p95 / p99 line chart per endpoint.
 *
 * Implementation: native SVG. We deliberately avoid pulling Recharts
 * into the bundle for v1 — the dashboard is read by Lumo operators on
 * a fast network and the chart shape is simple enough that hand-rolled
 * SVG keeps the bundle ~25kb lighter and SSRs cleanly. If Phase-3
 * adds a second team needing fancier interactions (zoom, brush,
 * tooltips with snap), swap to Recharts here without touching the
 * page.
 *
 * Accessibility: a `<table>` mirror of the data lives behind a
 * <details> so screen readers and keyboard users can read every value.
 * Color is paired with a legend dot AND a stroke-dasharray for the
 * percentile lines so a colour-blind viewer still distinguishes
 * p50 / p95 / p99.
 *
 * Color palette:
 *   p50 — solid blue   (latency · steady state)
 *   p95 — dashed blue
 *   p99 — dotted blue
 */

import { useMemo } from "react";
import type { TimeRange, TimeseriesBucket } from "@/lib/admin/intelligence-api";
import { formatBucketTs, formatLatency } from "@/lib/admin/intelligence-api";
import { ChartFrame, EmptyState } from "./ChartChrome";

interface Props {
  buckets: TimeseriesBucket[];
  range: TimeRange;
  isFixture?: boolean;
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 44 };
const HEIGHT = 220;
const WIDTH = 720;

export function LatencyChart({ buckets, range, isFixture }: Props) {
  const totalRequests = useMemo(
    () => buckets.reduce((s, b) => s + b.requests, 0),
    [buckets],
  );

  if (buckets.length === 0 || totalRequests === 0) {
    return (
      <ChartFrame
        title="Latency"
        subtitle="p50 / p95 / p99 per bucket"
        isFixture={isFixture}
      >
        <EmptyState>
          No requests in this time window — Brain SDK-1 may still be rolling
          out.
        </EmptyState>
      </ChartFrame>
    );
  }

  const max = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.p50_ms, b.p95_ms, b.p99_ms)),
  );
  const innerW = WIDTH - PADDING.left - PADDING.right;
  const innerH = HEIGHT - PADDING.top - PADDING.bottom;
  const stepX = innerW / Math.max(1, buckets.length - 1);

  const xAt = (i: number) => PADDING.left + i * stepX;
  const yAt = (v: number) => PADDING.top + innerH * (1 - v / max);

  const path = (key: "p50_ms" | "p95_ms" | "p99_ms") =>
    buckets
      .map((b, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(b[key]).toFixed(1)}`)
      .join(" ");

  // Y-axis ticks: 4 evenly spaced including max.
  const yTicks = [0, max / 4, max / 2, (max * 3) / 4, max].map((v) => ({
    v,
    label: formatLatency(v),
  }));

  // X-axis ticks: ~6 across the window.
  const xTickCount = 6;
  const xTickIdxs = Array.from({ length: xTickCount }, (_, k) =>
    Math.round((k * (buckets.length - 1)) / (xTickCount - 1)),
  );

  return (
    <ChartFrame
      title="Latency"
      subtitle={`p50 / p95 / p99 in ${formatLatency(max)} headroom`}
      isFixture={isFixture}
      legend={
        <ul className="flex items-center gap-3 text-[11px] text-lumo-fg-mid">
          <li className="flex items-center gap-1.5">
            <svg width="20" height="6" aria-hidden>
              <line x1="0" y1="3" x2="20" y2="3" stroke="#3b82f6" strokeWidth="2" />
            </svg>
            p50
          </li>
          <li className="flex items-center gap-1.5">
            <svg width="20" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="20"
                y2="3"
                stroke="#3b82f6"
                strokeWidth="2"
                strokeDasharray="4 3"
              />
            </svg>
            p95
          </li>
          <li className="flex items-center gap-1.5">
            <svg width="20" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="20"
                y2="3"
                stroke="#3b82f6"
                strokeWidth="2"
                strokeDasharray="1 3"
              />
            </svg>
            p99
          </li>
        </ul>
      }
    >
      <svg
        role="img"
        aria-label={`Latency chart, ${buckets.length} buckets, max ${formatLatency(max)}`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto"
      >
        {/* gridlines */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={yAt(t.v)}
              y2={yAt(t.v)}
              stroke="currentColor"
              strokeOpacity="0.08"
            />
            <text
              x={PADDING.left - 6}
              y={yAt(t.v)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-current text-[10px]"
              style={{ opacity: 0.5 }}
            >
              {t.label}
            </text>
          </g>
        ))}

        {/* x labels */}
        {xTickIdxs.map((idx) => (
          <text
            key={idx}
            x={xAt(idx)}
            y={HEIGHT - 8}
            textAnchor="middle"
            className="fill-current text-[10px]"
            style={{ opacity: 0.5 }}
          >
            {formatBucketTs(buckets[idx]?.ts ?? "", range)}
          </text>
        ))}

        {/* lines */}
        <path
          d={path("p99_ms")}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="1.5"
          strokeDasharray="1 3"
          strokeOpacity="0.7"
        />
        <path
          d={path("p95_ms")}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          strokeOpacity="0.85"
        />
        <path
          d={path("p50_ms")}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="2"
        />
      </svg>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-lumo-fg-low hover:text-lumo-fg-mid">
          Show data table
        </summary>
        <div className="mt-2 max-h-48 overflow-auto rounded-md border border-lumo-hair">
          <table className="w-full text-[11.5px]">
            <caption className="sr-only">Latency per time bucket</caption>
            <thead className="text-[10px] uppercase tracking-[0.14em] text-lumo-fg-low">
              <tr className="border-b border-lumo-hair">
                <th className="text-left p-1.5 font-normal">Bucket</th>
                <th className="text-right p-1.5 font-normal">p50</th>
                <th className="text-right p-1.5 font-normal">p95</th>
                <th className="text-right p-1.5 font-normal">p99</th>
                <th className="text-right p-1.5 font-normal">Reqs</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.ts} className="border-b border-lumo-hair last:border-0">
                  <td className="p-1.5 num text-lumo-fg-mid">
                    {formatBucketTs(b.ts, range)}
                  </td>
                  <td className="p-1.5 text-right num">{b.p50_ms}</td>
                  <td className="p-1.5 text-right num">{b.p95_ms}</td>
                  <td className="p-1.5 text-right num">{b.p99_ms}</td>
                  <td className="p-1.5 text-right num text-lumo-fg-mid">
                    {b.requests}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </ChartFrame>
  );
}
