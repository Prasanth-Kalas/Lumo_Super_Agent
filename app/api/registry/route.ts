/**
 * GET /api/registry — dump the current in-memory agent registry.
 *
 * Useful for ops dashboards and for the mobile shell to know which rich
 * components (flight card, cart card, etc.) to expect.
 */

import { ensureRegistry } from "@/lib/agent-registry";
import { snapshot } from "@/lib/circuit-breaker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const registry = await ensureRegistry();
    const breakers = snapshot();
    const agents = Object.values(registry.agents).map((a) => ({
      key: a.key,
      agent_id: a.manifest.agent_id,
      version: a.manifest.version,
      display_name: a.manifest.display_name,
      one_liner: a.manifest.one_liner,
      intents: a.manifest.intents,
      health_score: a.health_score,
      last_health: a.last_health,
      breaker: breakers[a.manifest.agent_id] ?? null,
      ui: a.manifest.ui,
      supported_regions: a.manifest.supported_regions,
    }));
    return Response.json({
      loaded_at: registry.loaded_at,
      tool_count: registry.bridge.tools.length,
      agents,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
