import { redirect } from "next/navigation";
import { IdentityEvidenceForm } from "@/components/developer/DeveloperForms";
import { getServerUser } from "@/lib/auth";
import { getIdentityVerification } from "@/lib/developer-dashboard";
import { MetricCard, PageHeading, Panel, shortDate } from "../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperIdentityPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/developer/identity-verification");
  const identity = await getIdentityVerification(user.id);
  const approved = identity.verification_tier === "legal_entity_verified";
  return (
    <div className="space-y-6">
      <PageHeading
        title="Identity verification"
        description="Email verification unlocks community submissions. Legal-entity verification unlocks verified-tier promotion requests."
      />
      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <MetricCard label="Tier" value={identity.verification_tier} sub="Current identity tier" />
        <MetricCard label="Review" value={identity.review_state} sub="TRUST-1 decision" />
        <MetricCard label="Submitted" value={shortDate(identity.submitted_at)} sub={identity.verified_at ? `Verified ${shortDate(identity.verified_at)}` : "Not approved yet"} />
      </section>
      <Panel title="Legal entity evidence" meta={approved ? "locked" : "editable"}>
        <IdentityEvidenceForm approved={approved} />
      </Panel>
    </div>
  );
}
