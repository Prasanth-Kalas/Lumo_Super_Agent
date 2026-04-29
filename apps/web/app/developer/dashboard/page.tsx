import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth";
import {
  getDeveloperAgents,
  getIdentityVerification,
  getSubmissionStatus,
  listPromotionRequests,
} from "@/lib/developer-dashboard";
import {
  AgentGrid,
  MetricCard,
  PageHeading,
  Panel,
  SubmissionTable,
  formatUsd,
} from "../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperDashboardPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/developer/dashboard");

  const [agents, submissions, identity, promotions] = await Promise.all([
    getDeveloperAgents(user.id),
    getSubmissionStatus(user.id),
    getIdentityVerification(user.id),
    listPromotionRequests(user.id),
  ]);
  const totals = agents.reduce(
    (acc, agent) => {
      acc.installs += agent.install_count;
      acc.invocations += agent.metrics_30d.invocations;
      acc.revenue += agent.metrics_30d.developer_share_usd;
      acc.errors += agent.metrics_30d.errors;
      return acc;
    },
    { installs: 0, invocations: 0, revenue: 0, errors: 0 },
  );

  return (
    <div className="space-y-6">
      <PageHeading
        title="Developer dashboard"
        description="Agent health, submissions, identity, and revenue from one author-facing cockpit."
        action={
          <Link
            href="/developer/submissions"
            className="inline-flex h-9 items-center justify-center rounded-md bg-lumo-accent px-3 text-[12.5px] font-medium text-white hover:opacity-90"
          >
            View submissions
          </Link>
        }
      />

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard label="Installs" value={totals.installs.toLocaleString("en-US")} sub="All time" />
        <MetricCard label="Invocations" value={totals.invocations.toLocaleString("en-US")} sub="Last 30 days" />
        <MetricCard label="Revenue" value={formatUsd(totals.revenue)} sub="Developer share" />
        <MetricCard label="Identity" value={identity.verification_tier} sub={identity.review_state} />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Panel title="Your agents" meta={`${agents.length} total`}>
          <AgentGrid agents={agents} />
        </Panel>
        <Panel title="Recent activity" meta="Submissions + promotion">
          <div className="space-y-3">
            {submissions.slice(0, 4).map((submission) => (
              <ActivityRow
                key={submission.id}
                href={`/developer/submissions/${encodeURIComponent(submission.id)}`}
                title={`${submission.agent_name} v${submission.version}`}
                meta={`review ${submission.review_state}`}
              />
            ))}
            {promotions.slice(0, 4).map((request) => (
              <ActivityRow
                key={request.id}
                href="/developer/promotion-requests"
                title={`${request.agent_id} → ${request.target_tier}`}
                meta={`promotion ${request.state}`}
              />
            ))}
            {submissions.length === 0 && promotions.length === 0 ? (
              <div className="rounded-md border border-dashed border-lumo-hair px-3 py-8 text-center text-[12.5px] text-lumo-fg-mid">
                Activity appears after your first submission.
              </div>
            ) : null}
          </div>
        </Panel>
      </div>

      <Panel title="Submission queue" meta={`${submissions.length} versions`}>
        <SubmissionTable submissions={submissions.slice(0, 8)} />
      </Panel>
    </div>
  );
}

function ActivityRow({
  href,
  title,
  meta,
}: {
  href: string;
  title: string;
  meta: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[12.5px] transition-colors hover:border-lumo-edge"
    >
      <span className="truncate text-lumo-fg">{title}</span>
      <span className="shrink-0 text-lumo-fg-low">{meta}</span>
    </Link>
  );
}
