import { notFound } from "next/navigation";
import { getServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { getReviewQueueItem } from "@/lib/trust/queue";
import { CheckReport } from "@/components/trust/CheckReport";
import { DecisionForm } from "@/components/trust/DecisionForm";
import { EligibilityCheck } from "@/components/trust/EligibilityCheck";
import { HealthSignalsTrend } from "@/components/trust/HealthSignalsTrend";

export const dynamic = "force-dynamic";

export default async function TrustReviewPage({ params }: { params: { id: string } }) {
  const user = await getServerUser();
  if (!isAdmin(user?.email)) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-[13px] text-red-300">
        Admin access is required.
      </div>
    );
  }
  const item = await getReviewQueueItem(params.id);
  if (!item) notFound();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-[24px] font-semibold">Review</h1>
        <p className="text-[13px] text-lumo-fg-mid">
          {item.request_type} · {item.agent_id ?? item.identity_user_id ?? "identity"} {item.agent_version ?? ""}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <section className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
            <div className="mb-3 text-[13px] font-medium text-lumo-fg">Automated checks</div>
            <CheckReport report={item.automated_checks} />
          </section>
          <EligibilityCheck report={item.eligibility_report} />
          <HealthSignalsTrend report={item.health_report} />
          <section className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
            <div className="mb-2 text-[13px] font-medium text-lumo-fg">Raw queue payload</div>
            <pre className="max-h-80 overflow-auto rounded-md bg-lumo-bg p-3 text-[11px] text-lumo-fg-mid">
              {JSON.stringify(item, null, 2)}
            </pre>
          </section>
        </div>
        <aside className="space-y-4">
          <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
            <div className="text-[12px] uppercase text-lumo-fg-low">SLA</div>
            <div className="mt-1 text-[14px] text-lumo-fg">{new Date(item.sla_due_at).toLocaleString()}</div>
            <div className="mt-3 text-[12px] uppercase text-lumo-fg-low">Priority</div>
            <div className="mt-1 text-[14px] text-lumo-fg">{item.priority}</div>
          </div>
          {item.state === "pending" || item.state === "in_review" ? (
            <DecisionForm queueId={item.id} />
          ) : (
            <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4 text-[13px] text-lumo-fg-mid">
              Decision already recorded.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
