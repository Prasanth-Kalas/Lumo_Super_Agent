"use client";

/**
 * ErrorRateChart — stacked area chart of error counts by error_class
 * over time.
 *
 * Bands are sorted with the highest-volume class on the bottom so the
 * eye lands on the dominant error first. Color follows the brand:
 * errors are red-family hues, with each error_class assigned a
 * deterministic shade so it's the same colour every render.
 *
 * Renders an accessible data table beneath the chart and a legend with
 * count totals so colour isn't the only signal.
 */

import { useMemo } from "react";
import type { TimeRange, TimeseriesBucket } from "@/lib/admin/intelligence-api";
import { formatBucketTs, formatCount } from "@/lib/admin/intelligence-api";
import { ChartFrame, EmptyState } from "./ChartChrome";

interface Props {
  buckets: TimeseriesBucket[];
  range: TimeRange;
  isFixture?: boolean;
}

const PADDING = { top: 12, right: 16, bottom: 28, left: 36 };
const HEIGHT = 200;
const WIDTH = 720;

const ERROR_PALETTE: Record<string, string> = {
  timeout: "#ef4444",
  rate_limited: "#f97316",
  upstream_5xx: "#dc2626",
  validation: "#f59e0b",
  auth: "#fb7185",
  unknown: "#9ca3af",
};

function colourFor(cls: string): string {
  return ERROR_PALETTE[cls] ?? "#ef4444";
}

export function ErrorRateChart({ buckets, range, isFixture }: Props) {
  const { classes, totalsByClass, stack, maxStack } = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const b of buckets) {
      for (const [k, v] of Object.entries(b.error_breakdown)) {
        totals[k] = (totals[k] ?? 0) + v;
      }
    }
    const orderedClasses = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);

    // Build stack: per bucket, cumulative bottoms keyed by class.
    const stackData = buckets.map((b) => {
      let acc = 0;
      const layers: Array<{ cls: string; y0: number; y1: number }> = [];
      for (const cls of orderedClasses) {
        const v = b.error_breakdown[cls] ?? 0;
        layers.push({ cls, y0: acc, y1: acc + v });
        acc += v;
      }
      return { ts: b.ts, top: acc, layers };
    });
    const maxStackVal = Math.max(1, ...stackData.map((s) => s.top));
    return {
      classes: orderedClasses,
      totalsByClass: totals,
      stack: stackData,
      maxStack: maxStackVal,
    };
  }, [buckets]);

  const totalErrors = useMemo(
    () => buckets.reduce((s, b) => s + b.errors, 0),
    [buckets],
  );

  if (buckets.length === 0 || totalErrors === 0) {
    return (
      <ChartFrame
        title="Errors"
        subtitle="By error_class, stacked"
        isFixture={isFixture}
      >
        <EmptyState>
          No errors in this time window. (When Brain SDK-1 starts emitting,
          this chart will fill in.)
        </EmptyState>
      </ChartFrame>
    );
  }

  const innerW = WIDTH - PADDING.left - PADDING.right;
  const innerH = HEIGHT - PADDING.top - PADDING.bottom;
  const stepX = innerW / Math.max(1, buckets.length - 1);
  const xAt = (i: number) => PADDING.left + i * stepX;
  const yAt = (v: number) => PADDING.top + innerH * (1 - v / maxStack);

  // Build a polygon per class.
  const polygons = classes.map((cls) => {
    const top: string[] = [];
    const bottom: string[] = [];
    stack.forEach((s, i) => {
      const layer = s.layers.find((l) => l.cls === cls);
      const y1 = layer?.y1 ?? 0;
      const y0 = layer?.y0 ?? 0;
      top.push(`${xAt(i).toFixed(1)},${yAt(y1).toFixed(1)}`);
      bottom.push(`${xAt(i).toFixed(1)},${yAt(y0).toFixed(1)}`);
    });
    const points = top.concat(bottom.reverse()).join(" ");
    return { cls, points };
  });

  const xTickCount = 6;
  const xTickIdxs = Array.from({ length: xTickCount }, (_, k) =>
    Math.round((k * (buckets.length - 1)) / (xTickCount - 1)),
  );

  return (
    <ChartFrame
      title="Errors"
      subtitle={`${formatCount(totalErrors)} errors across ${classes.length} classes`}
      isFixture={isFixture}
      legend={
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-lumo-fg-mid">
          {classes.map((c) => (
            <li key={c} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: colourFor(c) }}
              />
              <span className="num">{c}</span>
              <span className="text-lumo-fg-low num">
                {formatCount(totalsByClass[c] ?? 0)}
              </span>
            </li>
          ))}
        </ul>
      }
    >
      <svg
        role="img"
        aria-label={`Stacked error chart by class, total ${formatCount(totalErrors)} errors`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto"
      >
        {/* baseline */}
        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={yAt(0)}
          y2={yAt(0)}
          stroke="currentColor"
          strokeOpacity="0.15"
        />
        {/* y axis label (max) */}
        <text
          x={PADDING.left - 6}
          y={yAt(maxStack)}
          textAnchor="end"
          dominantBaseline="middle"
          className="fill-current text-[10px]"
          style={{ opacity: 0.5 }}
        >
          {formatCount(maxStack)}
        </text>
        <text
          x={PADDING.left - 6}
          y={yAt(0)}
          textAnchor="end"
          dominantBaseline="middle"
          className="fill-current text-[10px]"
          style={{ opacity: 0.5 }}
        >
          0
        </text>

        {polygons.map((p) => (
          <polygon
            key={p.cls}
            points={p.points}
            fill={colourFor(p.cls)}
            fillOpacity="0.55"
            stroke={colourFor(p.cls)}
            strokeOpacity="0.85"
            strokeWidth="0.8"
          />
        ))}

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
      </svg>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-lumo-fg-low hover:text-lumo-fg-mid">
          Show data table
        </summary>
        <div className="mt-2 max-h-48 overflow-auto rounded-md border border-lumo-hair">
          <table className="w-full text-[11.5px]">
            <caption className="sr-only">Errors per time bucket by class</caption>
            <thead className="text-[10px] uppercase tracking-[0.14em] text-lumo-fg-low">
              <tr className="border-b border-lumo-hair">
                <th className="text-left p-1.5 font-normal">Bucket</th>
                {classes.map((c) => (
                  <th key={c} className="text-right p-1.5 font-normal num">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.ts} className="border-b border-lumo-hair last:border-0">
                  <td className="p-1.5 num text-lumo-fg-mid">
                    {formatBucketTs(b.ts, range)}
                  </td>
                  {classes.map((c) => (
                    <td key={c} className="p-1.5 text-right num">
                      {b.error_breakdown[c] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </ChartFrame>
  );
}
