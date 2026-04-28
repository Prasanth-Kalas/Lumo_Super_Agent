"use client";

/**
 * CircuitBreakerStatus — current open / half-open / closed state per
 * brain endpoint, sourced from SDK-1's in-process breaker.
 *
 * Each row pairs a colour swatch with a textual state and a numeric
 * consecutive-failure count, so colour is never the only signal. Rows
 * are sorted "most worrying first" — open > half_open > closed.
 */

import type { EndpointSummary } from "@/lib/admin/intelligence-api";
import { ChartFrame, EmptyState } from "./ChartChrome";

interface Props {
  endpoints: EndpointSummary[];
  isFixture?: boolean;
}

const STATE_RANK: Record<string, number> = {
  open: 0,
  half_open: 1,
  closed: 2,
};

const STATE_TONE: Record<string, string> = {
  open: "bg-red-500/15 text-red-400 border-red-500/30",
  half_open: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  closed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
};

export function CircuitBreakerStatus({ endpoints, isFixture }: Props) {
  if (!endpoints || endpoints.length === 0) {
    return (
      <ChartFrame
        title="Circuit breakers"
        subtitle="Per-endpoint state from SDK-1"
        isFixture={isFixture}
      >
        <EmptyState>
          No endpoint state yet. SDK-1 publishes breaker state as it serves
          calls.
        </EmptyState>
      </ChartFrame>
    );
  }

  const rows = endpoints.slice().sort((a, b) => {
    const ra = STATE_RANK[a.circuit_breaker.state] ?? 9;
    const rb = STATE_RANK[b.circuit_breaker.state] ?? 9;
    if (ra !== rb) return ra - rb;
    return b.error_rate_24h - a.error_rate_24h;
  });

  return (
    <ChartFrame
      title="Circuit breakers"
      subtitle="Per-endpoint state from SDK-1"
      isFixture={isFixture}
    >
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {rows.map((r) => {
          const tone =
            STATE_TONE[r.circuit_breaker.state] ??
            STATE_TONE.closed ??
            "border-lumo-hair text-lumo-fg-mid";
          return (
            <li
              key={r.endpoint}
              className="flex items-start justify-between gap-3 rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-[12.5px] text-lumo-fg num truncate">
                  {r.endpoint}
                </div>
                <div className="text-[10.5px] text-lumo-fg-low num truncate">
                  {r.circuit_breaker.consecutive_failures} consecutive failures
                </div>
              </div>
              <span
                className={
                  "shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] border " +
                  tone
                }
              >
                {r.circuit_breaker.state.replace("_", "-")}
              </span>
            </li>
          );
        })}
      </ul>
    </ChartFrame>
  );
}
