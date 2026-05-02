import Link from "next/link";
import { redirect } from "next/navigation";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getServerUser } from "@/lib/auth";
import { getUserCostDashboard, type UserCostDashboard } from "@/lib/cost";

export const dynamic = "force-dynamic";

export default async function CostSettingsPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/settings/cost");

  const dashboard = await getUserCostDashboard(user.id);
  const dailyPct = usagePercent(
    dashboard.today.costUsdTotal,
    dashboard.budget.dailyCapUsd,
  );
  const monthlyPct = usagePercent(
    dashboard.month.costUsdTotal,
    dashboard.budget.monthlyCapUsd,
  );

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <Link href="/" className="flex items-center gap-2.5 hover:opacity-90">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">
              Settings · Cost
            </span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-5 py-8 space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
              Cost
            </h1>
            <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed max-w-2xl">
              Current spend, caps, and recent agent activity.
            </p>
          </div>
          <Link
            href="mailto:support@lumo.rentals?subject=Lumo%20budget%20tier%20upgrade"
            className="inline-flex h-9 items-center justify-center rounded-md bg-lumo-accent px-3 text-[12.5px] font-medium text-white hover:opacity-90"
          >
            Upgrade tier
          </Link>
        </div>

        <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <MetricCard
            label="Today"
            value={formatUsd(dashboard.today.costUsdTotal)}
            sub={capLabel(dashboard.budget.dailyCapUsd, dashboard.budget.softCap)}
          />
          <MetricCard
            label="This month"
            value={formatUsd(dashboard.month.costUsdTotal)}
            sub={capLabel(dashboard.budget.monthlyCapUsd, dashboard.budget.softCap)}
          />
          <MetricCard
            label="Tier"
            value={dashboard.budget.tier}
            sub={dashboard.budget.softCap ? "Soft cap" : "Hard cap"}
          />
        </section>

        <section
          id="budget"
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-5"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-[15px] font-semibold tracking-tight">Budget caps</h2>
            <span className="text-[11.5px] text-lumo-fg-low">
              Source: {dashboard.today.source}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <UsageBar
              label="Daily"
              spent={dashboard.today.costUsdTotal}
              cap={dashboard.budget.dailyCapUsd}
              percent={dailyPct}
            />
            <UsageBar
              label="Monthly"
              spent={dashboard.month.costUsdTotal}
              cap={dashboard.budget.monthlyCapUsd}
              percent={monthlyPct}
            />
          </div>
        </section>

        <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold tracking-tight">Last 30 days</h2>
            <span className="text-[11.5px] text-lumo-fg-low">
              {dashboard.daily.length} rollup days
            </span>
          </div>
          <TrendBars rows={dashboard.daily} />
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[0.92fr_1.08fr]">
          <AgentBreakdown agents={dashboard.agents} />
          <RecentInvocations recent={dashboard.recent} />
        </div>
      </div>
    </main>
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

function UsageBar({
  label,
  spent,
  cap,
  percent,
}: {
  label: string;
  spent: number;
  cap: number | null;
  percent: number | null;
}) {
  const width = percent === null ? 0 : Math.min(100, percent);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-[12.5px]">
        <span className="text-lumo-fg">{label}</span>
        <span className="text-lumo-fg-mid num">
          {formatUsd(spent)} / {cap === null ? "uncapped" : formatUsd(cap)}
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-lumo-elevated overflow-hidden">
        <div
          className={
            "h-full rounded-full " +
            (width >= 90
              ? "bg-red-500"
              : width >= 70
                ? "bg-amber-500"
                : "bg-lumo-accent")
          }
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="text-[11.5px] text-lumo-fg-low">
        {percent === null ? "No cap configured" : `${Math.round(percent)}% used`}
      </div>
    </div>
  );
}

function TrendBars({ rows }: { rows: UserCostDashboard["daily"] }) {
  if (rows.length === 0) {
    return <EmptyState text="No rollups yet." />;
  }
  const max = Math.max(...rows.map((row) => row.totalUsd), 0.01);
  return (
    <div className="flex h-28 items-end gap-1.5 overflow-x-auto border-b border-lumo-hair pb-2">
      {rows.map((row) => {
        const height = Math.max(4, Math.round((row.totalUsd / max) * 96));
        return (
          <div
            key={row.date}
            title={`${row.date}: ${formatUsd(row.totalUsd)} · ${row.invocations} calls`}
            className="flex min-w-5 flex-1 items-end justify-center"
          >
            <div
              className="w-full max-w-7 rounded-t-sm bg-lumo-accent/75"
              style={{ height }}
            />
          </div>
        );
      })}
    </div>
  );
}

function AgentBreakdown({ agents }: { agents: UserCostDashboard["agents"] }) {
  const max = Math.max(...agents.map((agent) => agent.totalUsd), 0.01);
  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-4">
      <h2 className="text-[15px] font-semibold tracking-tight">Agent breakdown</h2>
      {agents.length === 0 ? (
        <EmptyState text="No agent spend this month." />
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => (
            <div key={agent.agentId} className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="truncate text-lumo-fg">{agent.agentId}</span>
                <span className="shrink-0 text-lumo-fg-mid num">
                  {formatUsd(agent.totalUsd)}
                </span>
              </div>
              <div className="h-2 rounded-full bg-lumo-elevated overflow-hidden">
                <div
                  className="h-full rounded-full bg-lumo-accent/75"
                  style={{ width: `${Math.max(3, (agent.totalUsd / max) * 100)}%` }}
                />
              </div>
              <div className="text-[11px] text-lumo-fg-low num">
                {agent.invocations} invocation{agent.invocations === 1 ? "" : "s"}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentInvocations({ recent }: { recent: UserCostDashboard["recent"] }) {
  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-4">
      <h2 className="text-[15px] font-semibold tracking-tight">Recent invocations</h2>
      {recent.length === 0 ? (
        <EmptyState text="No cost events recorded yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
              <tr className="border-b border-lumo-hair">
                <th className="py-2 pr-3 text-left font-normal">Agent</th>
                <th className="py-2 pr-3 text-left font-normal">Status</th>
                <th className="py-2 pr-3 text-right font-normal">Cost</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr
                  key={`${row.createdAt}:${row.agentId}:${row.capabilityId ?? ""}`}
                  className="border-b border-lumo-hair last:border-0"
                >
                  <td className="py-2 pr-3 align-top">
                    <div className="max-w-[220px] truncate text-lumo-fg">
                      {row.agentId}
                    </div>
                    <div className="text-[11px] text-lumo-fg-low">
                      {formatDate(row.createdAt)}
                    </div>
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="py-2 pr-3 text-right align-top text-lumo-fg num">
                    {formatUsd(row.totalUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
      : status === "aborted_budget"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
        : "border-red-500/30 bg-red-500/10 text-red-400";
  return (
    <span className={"inline-flex rounded-full border px-2 py-0.5 text-[11px] " + tone}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-lumo-hair px-3 py-6 text-center text-[12.5px] text-lumo-fg-mid">
      {text}
    </div>
  );
}

function usagePercent(spend: number, cap: number | null): number | null {
  if (!cap || cap <= 0) return null;
  return (Math.max(0, spend) / cap) * 100;
}

function capLabel(cap: number | null, softCap: boolean): string {
  if (cap === null) return "Uncapped";
  return `${softCap ? "Soft" : "Hard"} cap ${formatUsd(cap)}`;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 10 ? 2 : 4,
  }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
