import { getDeveloperAgentMetrics } from "@/lib/developer-dashboard";
import { json, requireDeveloperUser } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { agent_id: string } },
): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const detail = await getDeveloperAgentMetrics({
    userId: auth.user.id,
    agentId: decodeURIComponent(params.agent_id),
    windowDays: 30,
  });
  if (!detail) return json({ error: "agent_not_found" }, 404);
  return json(detail);
}
