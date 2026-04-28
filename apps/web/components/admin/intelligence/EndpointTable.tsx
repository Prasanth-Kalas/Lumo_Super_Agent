"use client";

/**
 * EndpointTable — sortable table of brain endpoints with last-24h
 * metrics. Click a row to drill in (parent owns the selected endpoint
 * state).
 *
 * Sortable on every numeric column; the sort indicator is a glyph in
 * addition to colour so it works without colour. Single-click toggles
 * direction.
 */

import { useMemo, useState } from "react";
import type { EndpointSummary } from "@/lib/admin/intelligence-api";
import {
  formatCount,
  formatLatency,
  formatRate,
} from "@/lib/admin/intelligence-api";
import { ChartFrame, EmptyState } from "./ChartChrome";

type SortKey =
  | "endpoint"
  | "requests_24h"
  | "error_rate_24h"
  | "latency_p50_ms"
  | "latency_p95_ms"
  | "latency_p99_ms";

interface Props {
  endpoints: EndpointSummary[];
  selectedEndpoint: string | null;
  onSelect: (ep: string) => void;
  isFixture?: boolean;
}

export function EndpointTable({
  endpoints,
  selectedEndpoint,
  onSelect,
  isFixture,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("requests_24h");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const rows = endpoints.slice();
    rows.sort((a, b) => {
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [endpoints, sortKey, sortDir]);

  if (!endpoints || endpoints.length === 0) {
    return (
      <ChartFrame
        title="Endpoints"
        subtitle="Last 24h per brain endpoint · click a row to drill in"
        isFixture={isFixture}
      >
        <EmptyState>
          No brain endpoints have logged calls in the last 24 hours.
        </EmptyState>
      </ChartFrame>
    );
  }

  function header(key: SortKey, label: string, align: "left" | "right" = "right") {
    const active = sortKey === key;
    const dir = active ? (sortDir === "asc" ? "▲" : "▼") : "";
    return (
      <th
        scope="col"
        className={
          "p-2 font-normal text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low " +
          (align === "right" ? "text-right" : "text-left")
        }
      >
        <button
          type="button"
          onClick={() => {
            if (active) {
              setSortDir((d) => (d === "asc" ? "desc" : "asc"));
            } else {
              setSortKey(key);
              setSortDir(key === "endpoint" ? "asc" : "desc");
            }
          }}
          className="hover:text-lumo-fg-mid"
          aria-sort={
            active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
          }
        >
          {label} {dir}
        </button>
      </th>
    );
  }

  return (
    <ChartFrame
      title="Endpoints"
      subtitle="Last 24h per brain endpoint · click a row to drill in"
      isFixture={isFixture}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <caption className="sr-only">
            Brain endpoints: 24h request volume, error rate, p50/p95/p99
            latency, and breaker state.
          </caption>
          <thead>
            <tr className="border-b border-lumo-hair">
              {header("endpoint", "Endpoint", "left")}
              {header("requests_24h", "Reqs (24h)")}
              {header("error_rate_24h", "Err %")}
              {header("latency_p50_ms", "p50")}
              {header("latency_p95_ms", "p95")}
              {header("latency_p99_ms", "p99")}
              <th className="text-left p-2 font-normal text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
                Breaker
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const selected = r.endpoint === selectedEndpoint;
              const breakerTone =
                r.circuit_breaker.state === "open"
                  ? "text-red-400"
                  : r.circuit_breaker.state === "half_open"
                    ? "text-amber-400"
                    : "text-emerald-400";
              return (
                <tr
                  key={r.endpoint}
                  onClick={() => onSelect(r.endpoint)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(r.endpoint);
                    }
                  }}
                  tabIndex={0}
                  aria-selected={selected}
                  className={
                    "cursor-pointer border-b border-lumo-hair last:border-0 outline-none focus:bg-lumo-elevated " +
                    (selected ? "bg-lumo-elevated" : "hover:bg-lumo-elevated/60")
                  }
                >
                  <td className="p-2 align-top text-lumo-fg num">
                    {r.endpoint}
                  </td>
                  <td className="p-2 align-top text-right num">
                    {formatCount(r.requests_24h)}
                  </td>
                  <td
                    className={
                      "p-2 align-top text-right num " +
                      (r.error_rate_24h > 0.03
                        ? "text-red-400"
                        : r.error_rate_24h > 0.01
                          ? "text-amber-400"
                          : "")
                    }
                  >
                    {formatRate(r.error_rate_24h)}
                  </td>
                  <td className="p-2 align-top text-right num">
                    {formatLatency(r.latency_p50_ms)}
                  </td>
                  <td className="p-2 align-top text-right num">
                    {formatLatency(r.latency_p95_ms)}
                  </td>
                  <td className="p-2 align-top text-right num">
                    {formatLatency(r.latency_p99_ms)}
                  </td>
                  <td className={"p-2 align-top text-[11.5px] num " + breakerTone}>
                    {r.circuit_breaker.state.replace("_", "-")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}
