import Link from "next/link";
import type {
  DeveloperAgentMetrics,
  DeveloperAgentSummary,
  DeveloperSubmission,
} from "@/lib/developer-dashboard";

export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-lumo-fg">
          {title}
        </h1>
        <p className="max-w-2xl text-[13px] leading-relaxed text-lumo-fg-mid">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
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

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-lumo-hair px-3 py-8 text-center text-[12.5px] text-lumo-fg-mid">
      {text}
    </div>
  );
}

export function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-lumo-fg">
          {title}
        </h2>
        {meta ? (
          <span className="shrink-0 text-[11.5px] text-lumo-fg-low">{meta}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function AgentTable({ agents }: { agents: DeveloperAgentSummary[] }) {
  if (agents.length === 0) return <EmptyState text="No authored agents yet." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
          <tr className="border-b border-lumo-hair">
            <th className="py-2 pr-3 text-left font-normal">Agent</th>
            <th className="py-2 pr-3 text-left font-normal">Tier</th>
            <th className="py-2 pr-3 text-right font-normal">Installs</th>
            <th className="py-2 pr-3 text-right font-normal">Invocations</th>
            <th className="py-2 pr-3 text-right font-normal">Revenue</th>
            <th className="py-2 pr-3 text-right font-normal">Errors</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.agent_id} className="border-b border-lumo-hair last:border-0">
              <td className="py-2.5 pr-3">
                <Link
                  href={`/developer/agents/${encodeURIComponent(agent.agent_id)}`}
                  className="font-medium text-lumo-fg hover:text-lumo-accent"
                >
                  {agent.name}
                </Link>
                <div className="text-[11px] text-lumo-fg-low">{agent.agent_id}</div>
              </td>
              <td className="py-2.5 pr-3">
                <TierChip tier={agent.trust_tier} />
              </td>
              <td className="py-2.5 pr-3 text-right text-lumo-fg num">
                {agent.install_count.toLocaleString("en-US")}
              </td>
              <td className="py-2.5 pr-3 text-right text-lumo-fg-mid num">
                {agent.metrics_30d.invocations.toLocaleString("en-US")}
              </td>
              <td className="py-2.5 pr-3 text-right text-lumo-fg-mid num">
                {formatUsd(agent.metrics_30d.developer_share_usd)}
              </td>
              <td className="py-2.5 pr-3 text-right text-lumo-fg-mid num">
                {formatPct(agent.metrics_30d.error_rate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentGrid({ agents }: { agents: DeveloperAgentSummary[] }) {
  if (agents.length === 0) return <EmptyState text="No authored agents yet." />;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {agents.map((agent) => (
        <Link
          key={agent.agent_id}
          href={`/developer/agents/${encodeURIComponent(agent.agent_id)}`}
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 transition-colors hover:border-lumo-edge"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-lumo-fg">
                {agent.name}
              </div>
              <div className="truncate text-[11.5px] text-lumo-fg-low">
                {agent.agent_id}
              </div>
            </div>
            <TierChip tier={agent.trust_tier} />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
            <MiniStat label="Installs" value={agent.install_count} />
            <MiniStat label="Calls" value={agent.metrics_30d.invocations} />
            <MiniStat label="Revenue" value={formatUsd(agent.metrics_30d.developer_share_usd)} />
          </div>
        </Link>
      ))}
    </div>
  );
}

export function SubmissionTable({ submissions }: { submissions: DeveloperSubmission[] }) {
  if (submissions.length === 0) return <EmptyState text="No submissions yet." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
          <tr className="border-b border-lumo-hair">
            <th className="py-2 pr-3 text-left font-normal">Submission</th>
            <th className="py-2 pr-3 text-left font-normal">Review</th>
            <th className="py-2 pr-3 text-left font-normal">Security</th>
            <th className="py-2 pr-3 text-right font-normal">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((submission) => (
            <tr key={submission.id} className="border-b border-lumo-hair last:border-0">
              <td className="py-2.5 pr-3">
                <Link
                  href={`/developer/submissions/${encodeURIComponent(submission.id)}`}
                  className="font-medium text-lumo-fg hover:text-lumo-accent"
                >
                  {submission.agent_name}
                </Link>
                <div className="text-[11px] text-lumo-fg-low">
                  {submission.agent_id} · v{submission.version}
                </div>
              </td>
              <td className="py-2.5 pr-3 text-lumo-fg-mid">{submission.review_state}</td>
              <td className="py-2.5 pr-3 text-lumo-fg-mid">
                {submission.security_review?.outcome ?? "TRUST-1 pending"}
              </td>
              <td className="py-2.5 pr-3 text-right text-lumo-fg-low num">
                {shortDate(submission.submitted_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricsBars({ metrics }: { metrics: DeveloperAgentMetrics }) {
  const rows = metrics.hourly.slice(-48);
  if (rows.length === 0) return <EmptyState text="Metrics rollups will appear after the hourly cron runs." />;
  const maxInvocations = Math.max(...rows.map((row) => row.invocation_count), 1);
  const maxRevenue = Math.max(...rows.map((row) => row.developer_share_usd), 0.01);
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <ChartBars
        title="Invocation velocity"
        rows={rows.map((row) => ({
          key: row.hour,
          value: row.invocation_count,
          label: `${shortDate(row.hour)} · ${row.invocation_count} calls`,
        }))}
        max={maxInvocations}
        unit="calls"
      />
      <ChartBars
        title="Developer revenue"
        rows={rows.map((row) => ({
          key: row.hour,
          value: row.developer_share_usd,
          label: `${shortDate(row.hour)} · ${formatUsd(row.developer_share_usd)}`,
        }))}
        max={maxRevenue}
        unit="usd"
      />
    </div>
  );
}

export function LatencyPanel({
  p95,
  p99,
}: {
  p95: number | null;
  p99: number | null;
}) {
  if (p95 === null && p99 === null) {
    return (
      <div className="rounded-md border border-dashed border-lumo-hair px-3 py-8 text-center text-[12.5px] text-lumo-fg-mid">
        Latency data collection begins Phase 5.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <MiniStat label="p95 latency" value={p95 === null ? "—" : `${p95}ms`} />
      <MiniStat label="p99 latency" value={p99 === null ? "—" : `${p99}ms`} />
    </div>
  );
}

export function TopCapabilities({
  metrics,
}: {
  metrics: DeveloperAgentMetrics;
}) {
  const counts = new Map<string, number>();
  for (const row of metrics.hourly) {
    for (const capability of row.top_capabilities) {
      counts.set(
        capability.capability_id,
        (counts.get(capability.capability_id) ?? 0) + capability.invocation_count,
      );
    }
  }
  const rows = [...counts.entries()]
    .map(([capability, count]) => ({ capability, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  if (rows.length === 0) return <EmptyState text="No capability activity yet." />;
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.capability} className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[12.5px]">
            <span className="truncate text-lumo-fg">{row.capability}</span>
            <span className="shrink-0 text-lumo-fg-mid num">{row.count}</span>
          </div>
          <div className="h-2 rounded-full bg-lumo-elevated">
            <div
              className="h-full rounded-full bg-lumo-accent"
              style={{ width: `${Math.max(3, (row.count / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChartBars({
  title,
  rows,
  max,
  unit,
}: {
  title: string;
  rows: Array<{ key: string; value: number; label: string }>;
  max: number;
  unit: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[12.5px] font-medium text-lumo-fg">{title}</h3>
        <span className="text-[11.5px] text-lumo-fg-low">{unit}</span>
      </div>
      <div className="flex h-28 items-end gap-1.5 overflow-x-auto border-b border-lumo-hair pb-2">
        {rows.map((row) => {
          const height = Math.max(4, Math.round((row.value / max) * 96));
          return (
            <div key={row.key} className="flex min-w-4 flex-1 items-end" title={row.label}>
              <div
                className="w-full max-w-7 rounded-t-sm bg-lumo-accent/75"
                style={{ height }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-lumo-fg-low">
        {label}
      </div>
      <div className="mt-0.5 text-[16px] font-semibold text-lumo-fg num">{value}</div>
    </div>
  );
}

export function TierChip({ tier }: { tier: string }) {
  return (
    <span className="inline-flex h-6 items-center rounded-md border border-lumo-hair bg-lumo-elevated px-2 text-[11px] text-lumo-fg-mid">
      {tier}
    </span>
  );
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 10 ? 2 : 4,
  }).format(value);
}

export function formatPct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function shortDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}
