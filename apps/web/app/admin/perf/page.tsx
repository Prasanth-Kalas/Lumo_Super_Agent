import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth";
import {
  getAdminPerfDashboard,
  type AdminPerfDashboard,
  type PerfSlowTurn,
  type PerfStatRow,
} from "@/lib/perf/dashboard";
import { isAdmin } from "@/lib/publisher/access";

export const dynamic = "force-dynamic";

export default async function AdminPerfPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/admin/perf");
  if (!isAdmin(user.email)) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
        Not on the admin allowlist.
      </div>
    );
  }

  const dashboard = await getAdminPerfDashboard();
  const totalP50 =
    dashboard.phaseStats24h.find((row) => row.key === "total")?.p50Ms ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-[24px] font-semibold">
            Performance
          </h1>
          <p className="text-[13px] text-lumo-fg-mid">
            Orchestrator timings by phase, route bucket, and slow-turn outlier.
          </p>
        </div>
        <div className="rounded-full border border-lumo-hair bg-lumo-surface px-3 py-1 text-[11.5px] text-lumo-fg-mid">
          Total p50 <span className="num text-lumo-fg">{formatMs(totalP50)}</span>
        </div>
      </div>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {dashboard.bucketStats24h.map((row) => (
          <MetricCard key={row.key} row={row} />
        ))}
      </section>

      <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">
            Phase percentiles
          </h2>
          <span className="text-[11.5px] text-lumo-fg-low">Last 24h</span>
        </div>
        <StatsTable rows={dashboard.phaseStats24h} />
      </section>

      <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">
            Total p50 trend
          </h2>
          <span className="text-[11.5px] text-lumo-fg-low">
            {dashboard.totalTrend7d.length} hourly buckets
          </span>
        </div>
        <TrendBars rows={dashboard.totalTrend7d} />
      </section>

      <SlowTurnTable rows={dashboard.slowTurns} />
    </div>
  );
}

function MetricCard({ row }: { row: PerfStatRow }) {
  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4">
      <div className="text-[10.5px] uppercase text-lumo-fg-low">
        {row.label}
      </div>
      <div className="mt-1 text-[26px] font-semibold text-lumo-fg num">
        {formatMs(row.p50Ms)}
      </div>
      <div className="text-[12px] text-lumo-fg-mid">
        p95 {formatMs(row.p95Ms)} · {row.count.toLocaleString("en-US")} turns
      </div>
    </div>
  );
}

function StatsTable({ rows }: { rows: PerfStatRow[] }) {
  if (rows.every((row) => row.count === 0)) {
    return <EmptyState text="No timing spans have landed yet." />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead className="text-[10.5px] uppercase text-lumo-fg-low">
          <tr className="border-b border-lumo-hair">
            <th className="py-2 pr-3 text-left font-normal">Phase</th>
            <th className="py-2 pr-3 text-right font-normal">Count</th>
            <th className="py-2 pr-3 text-right font-normal">p50</th>
            <th className="py-2 pr-3 text-right font-normal">p95</th>
            <th className="py-2 pr-3 text-right font-normal">p99</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-lumo-hair last:border-0">
              <td className="py-2 pr-3 text-lumo-fg">{row.label}</td>
              <td className="py-2 pr-3 text-right text-lumo-fg-mid num">
                {row.count.toLocaleString("en-US")}
              </td>
              <td className="py-2 pr-3 text-right text-lumo-fg num">
                {formatMs(row.p50Ms)}
              </td>
              <td className="py-2 pr-3 text-right text-lumo-fg num">
                {formatMs(row.p95Ms)}
              </td>
              <td className="py-2 pr-3 text-right text-lumo-fg num">
                {formatMs(row.p99Ms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrendBars({ rows }: { rows: AdminPerfDashboard["totalTrend7d"] }) {
  if (rows.length === 0) return <EmptyState text="No total timing rows yet." />;
  const max = Math.max(...rows.map((row) => row.p50Ms), 1);
  return (
    <div className="flex h-32 items-end gap-1.5 overflow-x-auto border-b border-lumo-hair pb-2">
      {rows.map((row) => {
        const height = Math.max(4, Math.round((row.p50Ms / max) * 112));
        return (
          <div
            key={row.hour}
            title={`${formatDate(row.hour)}: ${formatMs(row.p50Ms)} p50 · ${row.count} turns`}
            className="flex min-w-6 flex-1 items-end justify-center"
          >
            <div
              className="w-full max-w-8 rounded-t-sm bg-lumo-accent/75"
              style={{ height }}
            />
          </div>
        );
      })}
    </div>
  );
}

function SlowTurnTable({ rows }: { rows: PerfSlowTurn[] }) {
  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Slow turns</h2>
        <span className="text-[11.5px] text-lumo-fg-low">Top 20, last 24h</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState text="No outliers yet." />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <details
              key={row.requestId}
              className="rounded-lg border border-lumo-hair bg-lumo-elevated px-3 py-2"
            >
              <summary className="cursor-pointer list-none">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div className="truncate text-[12.5px] text-lumo-fg num">
                    {row.requestId}
                  </div>
                  <div className="flex items-center gap-2 text-[11.5px] text-lumo-fg-mid">
                    <span>{row.bucket.replaceAll("_", " ")}</span>
                    <span className="num text-lumo-fg">{formatMs(row.totalMs)}</span>
                    <span>{formatDate(row.startedAt)}</span>
                  </div>
                </div>
              </summary>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <tbody>
                    {row.spans.map((span, idx) => (
                      <tr key={`${span.phase}-${idx}`} className="border-t border-lumo-hair">
                        <td className="py-1.5 pr-3 text-lumo-fg">
                          {span.phase.replaceAll("_", " ")}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-lumo-fg num">
                          {formatMs(span.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-lumo-hair bg-lumo-elevated px-3 py-6 text-center text-[12.5px] text-lumo-fg-low">
      {text}
    </div>
  );
}

function formatMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} s`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
  }).format(new Date(value));
}
