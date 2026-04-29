import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth";
import { getSubmissionStatus } from "@/lib/developer-dashboard";
import { PageHeading, Panel, SubmissionTable } from "../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperSubmissionsPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/developer/submissions");
  const submissions = await getSubmissionStatus(user.id);
  return (
    <div className="space-y-6">
      <PageHeading
        title="Submissions"
        description="Version submissions, review states, yanks, and security-review outcomes."
      />
      <Panel title="Version history" meta={`${submissions.length} rows`}>
        <SubmissionTable submissions={submissions} />
      </Panel>
    </div>
  );
}
