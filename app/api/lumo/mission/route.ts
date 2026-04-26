/**
 * POST /api/lumo/mission
 *
 * Non-mutating marketplace discovery for the Lumo mission gate. Given a
 * user request, returns which apps are ready, which apps need permission, and
 * which capabilities are not yet available in the approved marketplace.
 */

import type { NextRequest } from "next/server";
import { ensureRegistry } from "@/lib/agent-registry";
import { getServerUser } from "@/lib/auth";
import { listConnectionsForUser } from "@/lib/connections";
import { listInstalledAgentsForUser } from "@/lib/app-installs";
import { buildLumoMissionPlan } from "@/lib/lumo-mission";
import { selectMissionPlanningRequest } from "@/lib/mission-context";
import {
  describeRegistryAgents,
  evaluateRiskBadgesForAgents,
  rankAgentsForIntent,
} from "@/lib/marketplace-intelligence";
import { optimizeMissionTrip } from "@/lib/trip-optimization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  message?: unknown;
  messages?: Array<{ role?: unknown; content?: unknown }>;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const request = readMessage(body);
  if (!request) {
    return json({ error: "invalid_body", detail: "message is required" }, 400);
  }

  const user = await getServerUser();
  const user_id = user?.id ?? req.headers.get("x-lumo-user-id") ?? "anon";
  const registry = await ensureRegistry();
  const [connections, installs] =
    user_id && user_id !== "anon"
      ? await Promise.all([
          listConnectionsForUser(user_id),
          listInstalledAgentsForUser(user_id),
        ])
      : [[], []];
  const installedAgentIds = new Set(
    installs.filter((i) => i.status === "installed").map((i) => i.agent_id),
  );
  const agentDescriptors = describeRegistryAgents(registry, installedAgentIds);
  const [rankResult, riskBadges] = await Promise.all([
    rankAgentsForIntent({
      user_id,
      user_intent: request,
      agents: agentDescriptors,
      installed_agent_ids: Array.from(installedAgentIds),
      limit: 10,
    }),
    evaluateRiskBadgesForAgents({
      user_id,
      agents: agentDescriptors,
    }),
  ]);

  const planBase = buildLumoMissionPlan({
    request,
    registry,
    connections,
    installs,
    user_id,
    ranked_agents: rankResult.ranked_agents,
    risk_badges: riskBadges,
  });
  const tripOptimization =
    user_id !== "anon"
      ? await optimizeMissionTrip({
          user_id,
          plan: planBase,
        })
      : null;
  const plan = tripOptimization
    ? { ...planBase, trip_optimization: tripOptimization }
    : planBase;

  return json({
    plan,
    authenticated: !!user,
    intelligence: {
      rank_source: rankResult.source,
      rank_latency_ms: rankResult.latency_ms,
      rank_error: rankResult.error,
    },
  });
}

function readMessage(body: Body): string {
  if (typeof body.message === "string") return body.message.trim();
  const messages =
    body.messages
      ?.filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string",
      )
      .map((m) => ({ role: m.role, content: m.content })) ?? [];
  return selectMissionPlanningRequest(messages).trim();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
