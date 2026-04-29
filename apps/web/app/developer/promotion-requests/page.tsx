import { redirect } from "next/navigation";
import { PromotionRequestForm } from "@/components/developer/DeveloperForms";
import { getServerUser } from "@/lib/auth";
import {
  getDeveloperAgents,
  listPromotionRequests,
} from "@/lib/developer-dashboard";
import { EmptyState, PageHeading, Panel, shortDate } from "../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperPromotionRequestsPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/developer/promotion-requests");
  const [agents, requests] = await Promise.all([
    getDeveloperAgents(user.id),
    listPromotionRequests(user.id),
  ]);
  return (
    <div className="space-y-6">
      <PageHeading
        title="Promotion requests"
        description="Ask TRUST-1 reviewers to promote an agent from experimental to community, verified, or official."
      />
      <Panel title="New request">
        <PromotionRequestForm
          agents={agents.map((agent) => ({
            agent_id: agent.agent_id,
            name: agent.name,
            trust_tier: agent.trust_tier,
          }))}
        />
      </Panel>
      <Panel title="Request history" meta={`${requests.length} rows`}>
        {requests.length === 0 ? (
          <EmptyState text="No promotion requests yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
                <tr className="border-b border-lumo-hair">
                  <th className="py-2 pr-3 text-left font-normal">Agent</th>
                  <th className="py-2 pr-3 text-left font-normal">Target</th>
                  <th className="py-2 pr-3 text-left font-normal">State</th>
                  <th className="py-2 pr-3 text-right font-normal">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id} className="border-b border-lumo-hair last:border-0">
                    <td className="py-2.5 pr-3 text-lumo-fg">{request.agent_id}</td>
                    <td className="py-2.5 pr-3 text-lumo-fg-mid">{request.target_tier}</td>
                    <td className="py-2.5 pr-3 text-lumo-fg-mid">{request.state}</td>
                    <td className="py-2.5 pr-3 text-right text-lumo-fg-low num">
                      {shortDate(request.submitted_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
