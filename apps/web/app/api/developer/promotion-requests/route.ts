import {
  listPromotionRequests,
  requestPromotion,
  type PromotionTargetTier,
} from "@/lib/developer-dashboard";
import { json, readJson, requireDeveloperUser, stringField } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const requests = await listPromotionRequests(auth.user.id);
  return json({ requests });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const agentId = stringField(body, "agent_id");
  const targetTier = stringField(body, "target_tier");
  const reason = stringField(body, "reason");
  if (!agentId) return json({ error: "missing_agent_id" }, 400);
  if (!isPromotionTargetTier(targetTier)) return json({ error: "invalid_target_tier" }, 400);

  const result = await requestPromotion({
    userId: auth.user.id,
    agentId,
    targetTier,
    reason,
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ request: result.request }, 201);
}

function isPromotionTargetTier(value: string): value is PromotionTargetTier {
  return value === "community" || value === "verified" || value === "official";
}
