import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth";
import { getDeveloperAgentMetrics } from "@/lib/developer-dashboard";
import {
  EmptyState,
  LatencyPanel,
  MetricCard,
  MetricsBars,
  PageHeading,
  Panel,
  SubmissionTable,
  TopCapabilities,
  formatPct,
  formatUsd,
} from "../../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperAgentDetailPage({
  params,
}: {
  params: { agent_id: string };
}) {
  const user = await getServerUser();
  const agentId = decodeURIComponent(params.agent_id);
  if (!user) redirect(`/login?next=/developer/agents/${encodeURIComponent(agentId)}`);
  const metrics = await getDeveloperAgentMetrics({
    userId: user.id,
    agentId,
    windowDays: 30,
  });
  if (!metrics) {
    return (
      <div className="space-y-6">
        <PageHeading title="Agent not found" description="This agent is not authored by your account." />
        <Link className="text-[12.5px] text-lumo-accent hover:underline" href="/developer/agents">
          Back to agents
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeading
        title={metrics.agent.name}
        description={`${metrics.agent.agent_id} · v${metrics.agent.current_version ?? "unversioned"} · ${metrics.agent.state}`}
        action={
          <Link
            href="/developer/promotion-requests"
            className="inline-flex h-9 items-center rounded-md border border-lumo-hair bg-lumo-surface px-3 text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg"
          >
            Request promotion
          </Link>
        }
      />

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard label="Installs" value={metrics.agent.install_count.toLocaleString("en-US")} sub="All time" />
        <MetricCard label="Invocations" value={metrics.totals.invocations.toLocaleString("en-US")} sub="Last 30 days" />
        <MetricCard label="Revenue" value={formatUsd(metrics.totals.developer_share_usd)} sub="Developer share" />
        <MetricCard label="Error rate" value={formatPct(metrics.totals.error_rate)} sub={`${metrics.totals.errors} errors`} />
      </section>

      <Panel title="Velocity + revenue" meta={`${metrics.hourly.length} hourly buckets`}>
        <MetricsBars metrics={metrics} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Latency" meta="p95 / p99">
          <LatencyPanel p95={metrics.totals.p95_latency_ms} p99={metrics.totals.p99_latency_ms} />
        </Panel>
        <Panel title="Top capabilities">
          <TopCapabilities metrics={metrics} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <Panel title="Recent errors" meta="30 days">
          {metrics.errors.length === 0 ? (
            <EmptyState text="No failed invocations in this window." />
          ) : (
            <div className="space-y-2">
              {metrics.errors.slice(0, 10).map((error) => (
                <div key={error.request_id} className="rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2">
                  <div className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="truncate text-lumo-fg">{error.error_code ?? error.status}</span>
                    <span className="shrink-0 text-lumo-fg-low num">{error.redacted_user_id}</span>
                  </div>
                  <div className="mt-1 text-[11.5px] text-lumo-fg-low">
                    {error.capability_id ?? "unknown capability"} · {error.mission_step_id ?? "no mission step"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Versions" meta={`${metrics.versions.length} rows`}>
          <SubmissionTable submissions={metrics.versions} />
        </Panel>
      </div>
    </div>
  );
}
