/**
 * GET /api/health — the shell's own liveness + readiness.
 *
 * The shell is "ok" when at least one agent is healthy and the LLM key is set.
 * "degraded" when agents are all down but the shell process is fine.
 */

import { getRegistry } from "@/lib/agent-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const registry = getRegistry();
  const anthropic_configured = !!process.env.ANTHROPIC_API_KEY;
  const agents = registry ? Object.values(registry.agents) : [];
  const healthy_agents = agents.filter((a) => a.health_score >= 0.6);

  let status: "ok" | "degraded" | "down" = "ok";
  if (!anthropic_configured) status = "down";
  else if (registry && agents.length > 0 && healthy_agents.length === 0) status = "degraded";

  const statusCode = status === "ok" ? 200 : status === "degraded" ? 200 : 503;

  return Response.json(
    {
      status,
      agent_id: "lumo-super-agent",
      version: "0.1.0",
      checked_at: Date.now(),
      note: !anthropic_configured
        ? "ANTHROPIC_API_KEY is not set"
        : !registry
          ? "Registry not yet loaded"
          : undefined,
      upstream: Object.fromEntries(
        agents.map((a) => [
          a.manifest.agent_id,
          {
            status:
              a.health_score >= 0.6 ? "ok" : a.health_score > 0 ? "degraded" : "down",
            latency_ms: a.last_health?.p95_latency_ms,
            last_error: a.last_health ? undefined : "no recent probe",
          },
        ]),
      ),
    },
    { status: statusCode },
  );
}
