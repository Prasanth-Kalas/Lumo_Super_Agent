import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth";
import { getAdminCostDashboard, type AdminCostDashboard } from "@/lib/cost";
import { isAdmin } from "@/lib/publisher/access";

export const dynamic = "force-dynamic";

export default async function AdminCostPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/admin/cost");
  if (!isAdmin(user.email)) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
        Not on the admin allowlist.
      </div>
    );
  }

  const dashboard = await getAdminCostDashboard();
  const grossMargin =
    dashboard.monthUsd > 0
      ? ((dashboard.platformUsd / dashboard.monthUsd) * 100).toFixed(1)
      : "0.0";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Cost</h1>
          <p className="text-[13px] text-lumo-fg-mid">
            Platform spend, developer share, budget aborts, and anomalous users.
          </p>
        </div>
        <div className="rounded-full border border-lumo-hair bg-lumo-surface px-3 py-1 text-[11.5px] text-lumo-fg-mid">
          Gross margin <span className="num text-lumo-fg">{grossMargin}%</span>
        </div>
      </div>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard label="Today" value={formatUsd(dashboard.todayUsd)} sub="UTC window" />
        <MetricCard label="Month" value={formatUsd(dashboard.monthUsd)} sub="Current UTC month" />
        <MetricCard label="Platform" value={formatUsd(dashboard.platformUsd)} sub="Retained revenue" />
        <MetricCard label="Developer" value={formatUsd(dashboard.developerShareUsd)} sub="Share payable" />
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SmallStat
          label="Invocations"
          value={dashboard.invocationCount.toLocaleString("en-US")}
        />
        <SmallStat
          label="Budget aborts"
          value={dashboard.abortedBudgetCount.toLocaleString("en-US")}
        />
        <SmallStat
          label="Fallbacks"
          value={dashboard.fallbackCount.toLocaleString("en-US")}
        />
      </section>

      <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight">Spend trend</h2>
          <span className="text-[11.5px] text-lumo-fg-low">
            {dashboard.dailyTrend.length} days
          </span>
        </div>
        <TrendBars rows={dashboard.dailyTrend} />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RankedList
          title="Top agents"
          rows={dashboard.topAgents.map((row) => ({
            key: row.agentId,
            label: row.agentId,
            value: row.totalUsd,
            sub: `${row.invocations} invocation${row.invocations === 1 ? "" : "s"}`,
          }))}
        />
        <RankedList
          title="Top spenders"
          rows={dashboard.topUsers.map((row) => ({
            key: row.userBucket,
            label: row.userBucket,
            value: row.totalUsd,
            sub: `${row.invocations} invocation${row.invocations === 1 ? "" : "s"}`,
          }))}
        />
      </div>

      <AnomalyTable anomalies={dashboard.anomalies} />
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        {label}
      </div>
      <div className="mt-1 text-[26px] font-semibold tracking-tight text-lumo-fg num">
        {value}
      </div>
      <div className="text-[12px] text-lumo-fg-mid">{sub}</div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        {label}
      </div>
      <div className="text-[22px] font-semibold tracking-tight text-lumo-fg num">
        {value}
      </div>
    </div>
  );
}

function TrendBars({ rows }: { rows: AdminCostDashboard["dailyTrend"] }) {
  if (rows.length === 0) return <EmptyState text="No daily rollups yet." />;
  const max = Math.max(...rows.map((row) => row.totalUsd), 0.01);
  return (
    <div className="flex h-32 items-end gap-1.5 overflow-x-auto border-b border-lumo-hair pb-2">
      {rows.map((row) => {
        const height = Math.max(4, Math.round((row.totalUsd / max) * 112));
        return (
          <div
            key={row.date}
            title={`${row.date}: ${formatUsd(row.totalUsd)} · ${row.invocations} calls`}
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

function RankedList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; label: string; value: number; sub: string }>;
}) {
  const max = Math.max(...rows.map((row) => row.value), 0.01);
  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-4">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {rows.length === 0 ? (
        <EmptyState text="No rows yet." />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.key} className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="truncate text-lumo-fg">{row.label}</span>
                <span className="shrink-0 text-lumo-fg-mid num">
                  {formatUsd(row.value)}
                </span>
              </div>
              <div className="h-2 rounded-full bg-lumo-elevated overflow-hidden">
                <div
                  className="h-full rounded-full bg-lumo-accent/75"
                  style={{ width: `${Math.max(3, (row.value / max) * 100)}%` }}
                />
              </div>
              <div className="text-[11px] text-lumo-fg-low num">{row.sub}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AnomalyTable({ anomalies }: { anomalies: AdminCostDashboard["anomalies"] }) {
  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-4">
      <h2 className="text-[15px] font-semibold tracking-tight">Anomalies</h2>
      {anomalies.length === 0 ? (
        <EmptyState text="No anomalies in the current window." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
              <tr className="border-b border-lumo-hair">
                <th className="py-2 pr-3 text-left font-normal">User</th>
                <th className="py-2 pr-3 text-right font-normal">Today</th>
                <th className="py-2 pr-3 text-right font-normal">Month</th>
                <th className="py-2 pr-3 text-left font-normal">Reason</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((row) => (
                <tr key={row.userBucket} className="border-b border-lumo-hair last:border-0">
                  <td className="py-2 pr-3 text-lumo-fg num">{row.userBucket}</td>
                  <td className="py-2 pr-3 text-right text-lumo-fg num">
                    {formatUsd(row.todayUsd)}
                  </td>
                  <td className="py-2 pr-3 text-right text-lumo-fg-mid num">
                    {formatUsd(row.monthlyUsd)}
                  </td>
                  <td className="py-2 pr-3 text-lumo-fg-mid">{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-lumo-hair px-3 py-6 text-center text-[12.5px] text-lumo-fg-mid">
      {text}
    </div>
  );
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 10 ? 2 : 4,
  }).format(value);
}
