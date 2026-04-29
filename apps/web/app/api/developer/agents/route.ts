import { getDeveloperAgents } from "@/lib/developer-dashboard";
import { json, requireDeveloperUser } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const agents = await getDeveloperAgents(auth.user.id);
  return json({ agents });
}
