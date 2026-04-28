"use client";

/**
 * CostCard — placeholder for RUNTIME-1 cost data (Week 4).
 *
 * SDK-1 emits latency and outcome but not per-call cost. Cost
 * attribution lands with RUNTIME-1: provider routing forecaster,
 * prompt A/B harness, model routing per task class. Until then this
 * card communicates the budget envelope and sets the slot for the
 * future data without a redesign — the card body lays out exactly the
 * grid we expect to populate (spend so far, monthly forecast, top
 * model by cost, top endpoint by cost).
 *
 * The component accepts an optional `data` prop so RUNTIME-1 can drop
 * in the live values with zero markup churn.
 */

import { ChartFrame } from "./ChartChrome";

interface CostBreakdown {
  spend_mtd_usd: number;
  forecast_month_usd: number;
  by_model?: Array<{ model: string; spend_usd: number }>;
  by_endpoint?: Array<{ endpoint: string; spend_usd: number }>;
}

interface Props {
  data?: CostBreakdown | null;
  monthlyBudgetUsd?: number; // matches the Phase-3 <$150/mo target by default
}

export function CostCard({ data, monthlyBudgetUsd = 150 }: Props) {
  return (
    <ChartFrame
      title="Cost"
      subtitle={`Phase-3 envelope: < $${monthlyBudgetUsd}/mo at 1k MAU`}
      legend={
        data ? null : (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] uppercase tracking-[0.14em] border border-purple-500/30 bg-purple-500/10 text-purple-400">
            coming W4 · RUNTIME-1
          </span>
        )
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile
          label="Spend (MTD)"
          value={data ? formatUsd(data.spend_mtd_usd) : "—"}
          hint={data ? null : "RUNTIME-1 will populate"}
        />
        <Tile
          label="Forecast"
          value={data ? formatUsd(data.forecast_month_usd) : "—"}
          hint={data ? "End-of-month projection" : "RUNTIME-1 will populate"}
        />
        <Tile
          label="Top model"
          value={data?.by_model?.[0]?.model ?? "—"}
          hint={
            data?.by_model?.[0]
              ? formatUsd(data.by_model[0].spend_usd)
              : "RUNTIME-1 will populate"
          }
        />
        <Tile
          label="Top endpoint"
          value={data?.by_endpoint?.[0]?.endpoint ?? "—"}
          hint={
            data?.by_endpoint?.[0]
              ? formatUsd(data.by_endpoint[0].spend_usd)
              : "RUNTIME-1 will populate"
          }
        />
      </div>
      {!data ? (
        <p className="text-[12px] text-lumo-fg-mid leading-relaxed">
          Cost attribution lands with RUNTIME-1 in Week 4. SDK-1 emits
          latency and outcomes today; cost requires per-call model + token
          counts which RUNTIME-1 wires into <code className="text-lumo-fg">brain_call_log</code>.
        </p>
      ) : null}
    </ChartFrame>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string | null;
}) {
  return (
    <div className="rounded-lg border border-lumo-hair bg-lumo-bg p-3">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        {label}
      </div>
      <div className="mt-0.5 text-[18px] font-semibold tracking-tight text-lumo-fg num truncate">
        {value}
      </div>
      {hint ? (
        <div className="text-[11px] text-lumo-fg-low truncate">{hint}</div>
      ) : null}
    </div>
  );
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}
