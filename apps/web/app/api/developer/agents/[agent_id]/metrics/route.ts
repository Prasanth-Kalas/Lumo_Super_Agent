import { getDeveloperAgentMetrics } from "@/lib/developer-dashboard";
import { intParam, json, requireDeveloperUser } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: { agent_id: string } },
): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const metrics = await getDeveloperAgentMetrics({
    userId: auth.user.id,
    agentId: decodeURIComponent(params.agent_id),
    windowDays: intParam(url.searchParams.get("days"), 30, 90),
  });
  if (!metrics) return json({ error: "agent_not_found" }, 404);
  return json({
    agent: metrics.agent,
    window_days: metrics.window_days,
    totals: metrics.totals,
    hourly: metrics.hourly,
    recent_invocations: metrics.recent_invocations,
    errors: metrics.errors,
  });
}
