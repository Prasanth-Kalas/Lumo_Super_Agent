import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth";
import { getDeveloperAgents } from "@/lib/developer-dashboard";
import { AgentTable, PageHeading, Panel } from "../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperAgentsPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/developer/agents");
  const agents = await getDeveloperAgents(user.id);
  return (
    <div className="space-y-6">
      <PageHeading
        title="Agents"
        description="Every agent authored by your Lumo account, including pending and yanked catalog rows."
      />
      <Panel title="Authored agents" meta={`${agents.length} rows`}>
        <AgentTable agents={agents} />
      </Panel>
    </div>
  );
}
