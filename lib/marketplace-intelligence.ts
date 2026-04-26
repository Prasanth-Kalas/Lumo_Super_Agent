import type { AgentManifest } from "@lumo/agent-sdk";
import type { Registry, RegistryEntry } from "./agent-registry.js";
import type { ToolRoutingEntry } from "@lumo/agent-sdk";
import { redactForEmbedding } from "./content-indexing.js";
import { recordRuntimeUsage } from "./runtime-policy.js";
import { signLumoServiceJwt } from "./service-jwt.js";
import {
  evaluateAgentRiskCore,
  rankAgentsCore,
  riskBadgeFallback,
  type IntelligenceAgentDescriptor,
  type RankAgentsResult,
  type RiskBadge,
} from "./marketplace-intelligence-core.js";

const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_RANK_TOOL = "lumo_rank_agents";
const LUMO_RISK_TOOL = "lumo_evaluate_agent_risk";
const MARKETPLACE_INTELLIGENCE_TIMEOUT_MS = 300;
const RISK_CONCURRENCY = 6;

export type { IntelligenceAgentDescriptor, RankAgentsResult, RiskBadge };

export function describeRegistryAgents(
  registry: Registry,
  installedAgentIds: ReadonlySet<string> = new Set(),
): IntelligenceAgentDescriptor[] {
  return Object.values(registry.agents)
    .filter((entry) => entry.system !== true)
    .map((entry) => describeRegistryEntry(entry, installedAgentIds));
}

export function describeManifestForIntelligence(
  manifest: AgentManifest,
  args: {
    installed?: boolean;
    health_score?: number;
    source?: IntelligenceAgentDescriptor["source"];
  } = {},
): IntelligenceAgentDescriptor {
  return {
    agent_id: manifest.agent_id,
    display_name: manifest.display_name,
    domain: manifest.domain,
    category: manifest.listing?.category ?? manifest.domain,
    one_liner: manifest.one_liner,
    intents: manifest.intents ?? [],
    scopes: requiredScopeNames(manifest),
    installed: args.installed ?? false,
    connect_model: manifest.connect.model,
    requires_payment: manifest.requires_payment,
    pii_scope: manifest.pii_scope ?? [],
    health_score: args.health_score ?? 1,
    source: args.source ?? "lumo",
  };
}

export async function rankAgentsForIntent(args: {
  user_id: string;
  user_intent: string;
  agents: IntelligenceAgentDescriptor[];
  installed_agent_ids: string[];
  fetchImpl?: typeof fetch;
  mlBaseUrl?: string;
  timeoutMs?: number;
  limit?: number;
  recordUsage?: boolean;
}): Promise<RankAgentsResult> {
  const baseUrl = resolveMlBaseUrl(args.mlBaseUrl);
  const authorizationHeader = serviceAuthorizationHeader({
    baseUrl,
    user_id: args.user_id,
    scope: LUMO_RANK_TOOL,
  });
  return rankAgentsCore({
    user_id: args.user_id,
    user_intent: redactForEmbedding(args.user_intent).text,
    agents: args.agents,
    installed_agent_ids: args.installed_agent_ids,
    baseUrl,
    authorizationHeader,
    fetchImpl: args.fetchImpl ?? fetch,
    timeoutMs: clampInt(args.timeoutMs, 50, 2000, MARKETPLACE_INTELLIGENCE_TIMEOUT_MS),
    limit: clampInt(args.limit, 1, 25, 8),
    recordUsage: (ok, error_code, latency_ms) =>
      recordIntelligenceUsage({
        user_id: args.user_id,
        tool_name: LUMO_RANK_TOOL,
        ok,
        error_code,
        latency_ms,
        enabled: args.recordUsage,
      }),
  });
}

export async function evaluateRiskBadgesForAgents(args: {
  user_id: string;
  agents: IntelligenceAgentDescriptor[];
  fetchImpl?: typeof fetch;
  mlBaseUrl?: string;
  timeoutMs?: number;
  recordUsage?: boolean;
}): Promise<Map<string, RiskBadge>> {
  const baseUrl = resolveMlBaseUrl(args.mlBaseUrl);
  const authorizationHeader = serviceAuthorizationHeader({
    baseUrl,
    user_id: args.user_id,
    scope: LUMO_RISK_TOOL,
  });
  const peerScopes = buildPeerScopes(args.agents);
  const out = new Map<string, RiskBadge>();
  let next = 0;
  const workers = Array.from({
    length: Math.min(RISK_CONCURRENCY, Math.max(1, args.agents.length)),
  }).map(async () => {
    while (next < args.agents.length) {
      const agent = args.agents[next++];
      if (!agent) continue;
      const badge = await evaluateAgentRiskCore({
        user_id: args.user_id,
        agent,
        requested_scopes: agent.scopes,
        category_peer_scopes: peerScopes.get(peerKey(agent)) ?? [],
        baseUrl,
        authorizationHeader,
        fetchImpl: args.fetchImpl ?? fetch,
        timeoutMs: clampInt(args.timeoutMs, 50, 2000, MARKETPLACE_INTELLIGENCE_TIMEOUT_MS),
        recordUsage: (ok, error_code, latency_ms) =>
          recordIntelligenceUsage({
            user_id: args.user_id,
            tool_name: LUMO_RISK_TOOL,
            ok,
            error_code,
            latency_ms,
            enabled: args.recordUsage,
          }),
      });
      out.set(agent.agent_id, badge);
    }
  });
  await Promise.all(workers);
  return out;
}

export function fallbackRiskBadgeForAgent(agent: IntelligenceAgentDescriptor): RiskBadge {
  return riskBadgeFallback({ agent });
}

function describeRegistryEntry(
  entry: RegistryEntry,
  installedAgentIds: ReadonlySet<string>,
): IntelligenceAgentDescriptor {
  return describeManifestForIntelligence(entry.manifest, {
    installed: installedAgentIds.has(entry.manifest.agent_id),
    health_score: entry.health_score,
    source: "lumo",
  });
}

function requiredScopeNames(manifest: AgentManifest): string[] {
  if (manifest.connect.model !== "oauth2") return [];
  return manifest.connect.scopes
    .filter((scope) => scope.required)
    .map((scope) => scope.name);
}

function buildPeerScopes(
  agents: IntelligenceAgentDescriptor[],
): Map<string, string[][]> {
  const byCategory = new Map<string, string[][]>();
  for (const agent of agents) {
    const key = peerKey(agent);
    const peers = byCategory.get(key) ?? [];
    peers.push(agent.scopes);
    byCategory.set(key, peers);
  }
  return byCategory;
}

function peerKey(agent: IntelligenceAgentDescriptor): string {
  return (agent.category ?? agent.domain ?? agent.source ?? "general").toLowerCase();
}

function resolveMlBaseUrl(override: string | undefined): string {
  return (
    override ??
    process.env.LUMO_ML_AGENT_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:3010" : "")
  ).replace(/\/+$/, "");
}

function serviceAuthorizationHeader(args: {
  baseUrl: string;
  user_id: string;
  scope: string;
}): string | null {
  if (!args.baseUrl || !process.env.LUMO_ML_SERVICE_JWT_SECRET) return null;
  if (!args.user_id || args.user_id === "anon") return null;
  return `Bearer ${signLumoServiceJwt({
    audience: LUMO_ML_AGENT_ID,
    user_id: args.user_id,
    scope: args.scope,
    ttl_seconds: 60,
  })}`;
}

async function recordIntelligenceUsage(args: {
  user_id: string;
  tool_name: string;
  ok: boolean;
  error_code: string | undefined;
  latency_ms: number;
  enabled?: boolean;
}): Promise<void> {
  if (args.enabled === false) return;
  await recordRuntimeUsage({
    user_id: args.user_id,
    agent_id: LUMO_ML_AGENT_ID,
    tool_name: args.tool_name,
    cost_tier: "free" as ToolRoutingEntry["cost_tier"],
    ok: args.ok,
    error_code: args.error_code,
    latency_ms: args.latency_ms,
    system_agent: true,
  });
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(Number(value));
  return Math.min(max, Math.max(min, n));
}
