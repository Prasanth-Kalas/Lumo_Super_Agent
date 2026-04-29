import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth";
import { getSubmissionDetail } from "@/lib/developer-dashboard";
import { MetricCard, PageHeading, Panel, shortDate } from "../../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperSubmissionDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await getServerUser();
  if (!user) redirect(`/login?next=/developer/submissions/${encodeURIComponent(params.id)}`);
  const submission = await getSubmissionDetail({
    userId: user.id,
    submissionId: params.id,
  });
  if (!submission) {
    return (
      <div className="space-y-6">
        <PageHeading title="Submission not found" description="This submission was not found for your author account." />
        <Link href="/developer/submissions" className="text-[12.5px] text-lumo-accent hover:underline">
          Back to submissions
        </Link>
      </div>
    );
  }
  const review = submission.security_review;
  return (
    <div className="space-y-6">
      <PageHeading
        title={`${submission.agent_name} v${submission.version}`}
        description={`${submission.agent_id} · ${submission.review_state}`}
      />
      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard label="Review" value={submission.review_state} sub="Marketplace version" />
        <MetricCard label="Trust tier" value={submission.trust_tier} sub="Requested catalog tier" />
        <MetricCard label="Signature" value={submission.signature_verified ? "verified" : "pending"} sub="TRUST-1 finalizes" />
        <MetricCard label="Submitted" value={shortDate(submission.submitted_at)} sub={submission.yanked ? "Yanked" : "Active row"} />
      </section>
      <Panel title="Security review">
        {review ? (
          <div className="space-y-3 text-[12.5px]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Detail label="Outcome" value={review.outcome} />
              <Detail label="Reviewer" value={review.reviewer} />
              <Detail label="Reviewed" value={shortDate(review.reviewed_at)} />
            </div>
            <div className="rounded-md border border-lumo-hair bg-lumo-bg p-3 text-lumo-fg-mid">
              {review.notes ?? "No reviewer notes."}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-lumo-hair px-3 py-8 text-center text-[12.5px] text-lumo-fg-mid">
            TRUST-1 will populate automated checks and human review outcomes here.
          </div>
        )}
      </Panel>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-lumo-fg-low">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] text-lumo-fg">{value}</div>
    </div>
  );
}
