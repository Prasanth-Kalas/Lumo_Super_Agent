export type IntelligenceSource = "ml" | "fallback";
export type RiskLevel = "low" | "medium" | "high" | "review_required";

export interface IntelligenceAgentDescriptor {
  agent_id: string;
  display_name: string;
  domain?: string | null;
  category?: string | null;
  one_liner?: string | null;
  intents: string[];
  scopes: string[];
  installed: boolean;
  connect_model?: string | null;
  requires_payment?: boolean;
  pii_scope?: string[];
  health_score?: number;
  source?: "lumo" | "mcp" | "coming_soon";
}

export interface RankedAgentResult {
  agent_id: string;
  display_name: string;
  score: number;
  installed: boolean;
  reasons: string[];
  missing_scopes: string[];
}

export interface RankAgentsResult {
  ranked_agents: RankedAgentResult[];
  missing_capabilities: string[];
  source: IntelligenceSource;
  latency_ms: number;
  error?: string;
}

export interface RiskBadge {
  level: RiskLevel;
  score: number;
  reasons: string[];
  mitigations: string[];
  source: IntelligenceSource;
  latency_ms: number;
  error?: string;
}

interface RankResponseBody {
  ranked_agents?: Array<Partial<RankedAgentResult>>;
  missing_capabilities?: unknown;
}

interface RiskResponseBody {
  risk_level?: unknown;
  score?: unknown;
  flags?: unknown;
  reasons?: unknown;
  mitigations?: unknown;
}

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  flight: ["flight", "flights", "fly", "airport", "airline", "airfare", "round trip", "return"],
  hotel: ["hotel", "hotels", "stay", "room", "lodging", "resort", "check in", "check out", "vegas"],
  maps: ["map", "maps", "route", "directions", "drive", "cab", "cabs", "taxi", "transport"],
  food: ["food", "delivery", "restaurant", "dinner", "lunch", "breakfast", "doordash", "takeout"],
  events: ["event", "events", "concert", "show", "festival", "tickets", "game"],
  attractions: ["attraction", "attractions", "things to do", "museum", "tour", "landmark", "sightseeing"],
  ev: ["ev", "electric", "charging", "charger", "chargers", "ccs", "chademo"],
};

const PREFERRED_AGENT_IDS: Record<string, string[]> = {
  flight: ["flight"],
  hotel: ["hotel"],
  maps: ["open-maps"],
  food: ["food", "restaurant"],
  events: ["open-events"],
  attractions: ["open-attractions"],
  ev: ["open-ev-charging"],
};

const SENSITIVE_SCOPE_TERMS: Array<{ term: string; weight: number; reason: string }> = [
  { term: "payment", weight: 0.28, reason: "Requests payment access" },
  { term: "payment_method", weight: 0.28, reason: "Requests payment method access" },
  { term: "card", weight: 0.24, reason: "Requests card access" },
  { term: "write", weight: 0.16, reason: "Can modify user data" },
  { term: "send", weight: 0.18, reason: "Can send messages or emails" },
  { term: "book", weight: 0.18, reason: "Can book reservations or travel" },
  { term: "order", weight: 0.18, reason: "Can place orders" },
  { term: "message", weight: 0.16, reason: "Can access messages" },
  { term: "email", weight: 0.12, reason: "Can access email identity or mail" },
  { term: "location", weight: 0.1, reason: "Uses location data" },
  { term: "address", weight: 0.12, reason: "Uses address data" },
  { term: "phone", weight: 0.1, reason: "Uses phone number data" },
  { term: "passport", weight: 0.3, reason: "Requests passport or travel identity data" },
];

export async function rankAgentsCore(args: {
  user_id: string;
  user_intent: string;
  agents: IntelligenceAgentDescriptor[];
  installed_agent_ids: string[];
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  limit: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<RankAgentsResult> {
  const started = Date.now();
  const fallback = () =>
    rankAgentsFallback(args.user_intent, args.agents, args.installed_agent_ids, args.limit);
  if (args.agents.length === 0) {
    return { ranked_agents: [], missing_capabilities: [], source: "fallback", latency_ms: 0 };
  }
  if (!args.baseUrl || !args.authorizationHeader) {
    return {
      ...fallback(),
      source: "fallback",
      latency_ms: Date.now() - started,
      error: "ml_ranker_not_configured",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/rank_agents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: args.authorizationHeader,
        "x-lumo-user-id": args.user_id,
      },
      body: JSON.stringify({
        user_intent: args.user_intent,
        agents: args.agents.map(toBrainAgentDescriptor),
        installed_agent_ids: args.installed_agent_ids,
        limit: args.limit,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const error_code = `http_${res.status}`;
      await args.recordUsage(false, error_code, latency_ms);
      return { ...fallback(), source: "fallback", latency_ms, error: error_code };
    }
    const body = (await res.json()) as RankResponseBody;
    const ranked_agents = normalizeRankedAgents(body.ranked_agents, args.agents, args.limit);
    if (ranked_agents.length === 0) {
      await args.recordUsage(false, "malformed_response", latency_ms);
      return { ...fallback(), source: "fallback", latency_ms, error: "malformed_response" };
    }
    await args.recordUsage(true, undefined, latency_ms);
    return {
      ranked_agents,
      missing_capabilities: normalizeStringArray(body.missing_capabilities),
      source: "ml",
      latency_ms,
    };
  } catch (err) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    const error_code = err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error";
    await args.recordUsage(false, error_code, latency_ms);
    return { ...fallback(), source: "fallback", latency_ms, error: error_code };
  }
}

export async function evaluateAgentRiskCore(args: {
  user_id: string;
  agent: IntelligenceAgentDescriptor;
  requested_scopes?: string[];
  category_peer_scopes?: string[][];
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<RiskBadge> {
  const started = Date.now();
  const requestedScopes = args.requested_scopes ?? args.agent.scopes;
  if (!args.baseUrl || !args.authorizationHeader) {
    return riskBadgeFallback({
      agent: args.agent,
      requested_scopes: requestedScopes,
      category_peer_scopes: args.category_peer_scopes,
      latency_ms: Date.now() - started,
      error: "ml_risk_not_configured",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/evaluate_agent_risk`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: args.authorizationHeader,
        "x-lumo-user-id": args.user_id,
      },
      body: JSON.stringify({
        agent: toBrainAgentDescriptor(args.agent),
        requested_scopes: requestedScopes,
        category_peer_scopes: args.category_peer_scopes ?? [],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const error_code = `http_${res.status}`;
      await args.recordUsage(false, error_code, latency_ms);
      return riskBadgeFallback({
        agent: args.agent,
        requested_scopes: requestedScopes,
        category_peer_scopes: args.category_peer_scopes,
        latency_ms,
        error: error_code,
        force_review: true,
      });
    }
    const body = (await res.json()) as RiskResponseBody;
    const badge = normalizeRiskBadge(body, latency_ms);
    if (!badge) {
      await args.recordUsage(false, "malformed_response", latency_ms);
      return riskBadgeFallback({
        agent: args.agent,
        requested_scopes: requestedScopes,
        category_peer_scopes: args.category_peer_scopes,
        latency_ms,
        error: "malformed_response",
        force_review: true,
      });
    }
    await args.recordUsage(true, undefined, latency_ms);
    return badge;
  } catch (err) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    const error_code = err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error";
    await args.recordUsage(false, error_code, latency_ms);
    return riskBadgeFallback({
      agent: args.agent,
      requested_scopes: requestedScopes,
      category_peer_scopes: args.category_peer_scopes,
      latency_ms,
      error: error_code,
      force_review: true,
    });
  }
}

export function rankAgentsFallback(
  user_intent: string,
  agents: IntelligenceAgentDescriptor[],
  installed_agent_ids: string[],
  limit = 8,
): Omit<RankAgentsResult, "source" | "latency_ms" | "error"> {
  const installed = new Set(installed_agent_ids);
  const required = requiredCapabilities(user_intent);
  const ranked = agents
    .map((agent) => scoreAgentForIntent(user_intent, agent, required, installed))
    .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
    .slice(0, Math.max(1, limit));
  const covered = new Set<string>();
  for (const agent of agents) {
    if (!agent.installed && !installed.has(agent.agent_id)) continue;
    const capability = capabilityForAgent(agent);
    if (capability) covered.add(capability);
  }
  const missing_capabilities = Array.from(required)
    .filter((capability) => !covered.has(capability))
    .sort();
  return { ranked_agents: ranked, missing_capabilities };
}

export function riskBadgeFallback(args: {
  agent: IntelligenceAgentDescriptor;
  requested_scopes?: string[];
  category_peer_scopes?: string[][];
  latency_ms?: number;
  error?: string;
  force_review?: boolean;
}): RiskBadge {
  const scopes = args.requested_scopes ?? args.agent.scopes;
  const reasons: string[] = [];
  let score = Math.min(1, scopes.length * 0.08);
  for (const scope of scopes) {
    const lower = scope.toLowerCase();
    for (const item of SENSITIVE_SCOPE_TERMS) {
      if (lower.includes(item.term)) {
        score = Math.min(1, score + item.weight);
        if (!reasons.includes(item.reason)) reasons.push(item.reason);
      }
    }
  }
  for (const field of args.agent.pii_scope ?? []) {
    const lower = field.toLowerCase();
    if (lower.includes("payment")) {
      score = Math.min(1, score + 0.24);
      if (!reasons.includes("Uses payment profile data")) reasons.push("Uses payment profile data");
    } else if (["address", "phone", "email"].some((term) => lower.includes(term))) {
      score = Math.min(1, score + 0.08);
      if (!reasons.includes("Uses personal contact data")) reasons.push("Uses personal contact data");
    }
  }
  if (args.agent.requires_payment) {
    score = Math.min(1, score + 0.22);
    reasons.push("Can participate in money-moving flows");
  }
  if (args.category_peer_scopes?.length) {
    const avg =
      args.category_peer_scopes.reduce((sum, peer) => sum + peer.length, 0) /
      args.category_peer_scopes.length;
    if (scopes.length > Math.max(avg * 1.5, avg + 2)) {
      score = Math.min(1, score + 0.18);
      reasons.push("Requests more scopes than category peers");
    }
  }

  let level: RiskLevel = score >= 0.68 ? "high" : score >= 0.34 ? "medium" : "low";
  if (args.force_review && level === "low") {
    level = "review_required";
    score = Math.max(score, 0.5);
    reasons.push("Risk service unavailable; review before connecting");
  }
  if (args.agent.source === "coming_soon" && level === "low") {
    level = "review_required";
    score = Math.max(score, 0.45);
    reasons.push("Not connectable yet; app review still pending");
  }
  if (reasons.length === 0) reasons.push("No sensitive required scopes detected");

  return {
    level,
    score: clampScore(score),
    reasons: dedupe(reasons).slice(0, 4),
    mitigations: mitigationsForLevel(level),
    source: "fallback",
    latency_ms: Math.max(0, Math.round(args.latency_ms ?? 0)),
    error: args.error,
  };
}

export function shouldRunMarketplaceIntelligence(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized) return false;
  return [
    "app",
    "agent",
    "marketplace",
    "install",
    "connect",
    "trip",
    "travel",
    "vegas",
    "flight",
    "hotel",
    "cab",
    "taxi",
    "food",
    "restaurant",
    "event",
    "attraction",
    "charging",
  ].some((phrase) => includesPhrase(normalized, phrase));
}

function toBrainAgentDescriptor(agent: IntelligenceAgentDescriptor) {
  return {
    agent_id: agent.agent_id,
    display_name: agent.display_name,
    domain: agent.domain ?? undefined,
    category: agent.category ?? undefined,
    intents: agent.intents,
    scopes: agent.scopes,
    installed: agent.installed,
    connect_model: agent.connect_model ?? undefined,
    requires_payment: agent.requires_payment ?? false,
    pii_scope: agent.pii_scope ?? [],
  };
}

function normalizeRankedAgents(
  items: RankResponseBody["ranked_agents"],
  agents: IntelligenceAgentDescriptor[],
  limit: number,
): RankedAgentResult[] {
  if (!Array.isArray(items)) return [];
  const byId = new Map(agents.map((agent) => [agent.agent_id, agent]));
  return items
    .flatMap((item) => {
      if (!item || typeof item.agent_id !== "string") return [];
      const agent = byId.get(item.agent_id);
      if (!agent) return [];
      const score = typeof item.score === "number" && Number.isFinite(item.score)
        ? item.score
        : 0;
      return [
        {
          agent_id: agent.agent_id,
          display_name:
            typeof item.display_name === "string" && item.display_name.length > 0
              ? item.display_name
              : agent.display_name,
          score: clampScore(score),
          installed: typeof item.installed === "boolean" ? item.installed : agent.installed,
          reasons: normalizeStringArray(item.reasons).slice(0, 5),
          missing_scopes: normalizeStringArray(item.missing_scopes).slice(0, 8),
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
    .slice(0, limit);
}

function normalizeRiskBadge(body: RiskResponseBody, latency_ms: number): RiskBadge | null {
  const level = normalizeRiskLevel(body.risk_level);
  if (!level) return null;
  const score = typeof body.score === "number" && Number.isFinite(body.score)
    ? clampScore(body.score)
    : level === "high"
      ? 0.8
      : level === "medium"
        ? 0.5
        : 0.16;
  const reasons = [
    ...normalizeStringArray(body.reasons),
    ...normalizeStringArray(body.flags),
  ];
  return {
    level,
    score,
    reasons: dedupe(reasons).slice(0, 4),
    mitigations: normalizeStringArray(body.mitigations).slice(0, 4),
    source: "ml",
    latency_ms: Math.max(0, Math.round(latency_ms)),
  };
}

function normalizeRiskLevel(value: unknown): RiskLevel | null {
  return value === "low" || value === "medium" || value === "high" || value === "review_required"
    ? value
    : null;
}

function scoreAgentForIntent(
  intent: string,
  agent: IntelligenceAgentDescriptor,
  required: Set<string>,
  installed: Set<string>,
): RankedAgentResult {
  const haystack = normalizeText(
    [
      agent.agent_id,
      agent.display_name,
      agent.domain ?? "",
      agent.category ?? "",
      agent.one_liner ?? "",
      ...agent.intents,
    ].join(" "),
  );
  const intentTerms = terms(intent);
  const agentTerms = terms(haystack);
  const overlap = Array.from(intentTerms).filter((term) => agentTerms.has(term)).length;
  const capability = capabilityForAgent(agent);
  const capabilityHit = capability ? required.has(capability) : false;
  const preferredHit =
    capability && (PREFERRED_AGENT_IDS[capability] ?? []).includes(agent.agent_id);
  const isInstalled = agent.installed || installed.has(agent.agent_id);
  let score = 0.08 + Math.min(0.24, overlap * 0.04);
  const reasons: string[] = [];
  if (capability && capabilityHit) {
    score += 0.46;
    reasons.push(`Covers ${capabilityLabel(capability)}`);
  }
  if (preferredHit) {
    score += 0.16;
    reasons.push("Preferred app for this capability");
  }
  if (overlap > 0) reasons.push(`Matches ${overlap} intent term${overlap === 1 ? "" : "s"}`);
  if (isInstalled) {
    score += 0.08;
    reasons.push("Already available to this user");
  }
  if ((agent.health_score ?? 1) < 0.6) {
    score -= 0.28;
    reasons.push("Health score below routing threshold");
  }
  return {
    agent_id: agent.agent_id,
    display_name: agent.display_name,
    score: clampScore(score),
    installed: isInstalled,
    reasons: reasons.length > 0 ? dedupe(reasons).slice(0, 5) : ["General marketplace candidate"],
    missing_scopes: isInstalled ? [] : agent.scopes.slice(0, 8),
  };
}

function requiredCapabilities(intent: string): Set<string> {
  const normalized = normalizeText(intent);
  const out = new Set<string>();
  for (const [capability, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
    if (keywords.some((keyword) => includesPhrase(normalized, keyword))) out.add(capability);
  }
  if (
    includesPhrase(normalized, "trip") ||
    includesPhrase(normalized, "travel") ||
    includesPhrase(normalized, "vegas")
  ) {
    ["flight", "hotel", "maps", "food", "events", "attractions"].forEach((capability) =>
      out.add(capability),
    );
  }
  if (
    includesPhrase(normalized, "drive") ||
    includesPhrase(normalized, "ev") ||
    includesPhrase(normalized, "charging") ||
    includesPhrase(normalized, "electric")
  ) {
    out.add("ev");
  }
  return out;
}

function capabilityForAgent(agent: IntelligenceAgentDescriptor): string | null {
  const haystack = normalizeText(
    [
      agent.agent_id,
      agent.display_name,
      agent.domain ?? "",
      agent.category ?? "",
      agent.one_liner ?? "",
      ...agent.intents,
    ].join(" "),
  );
  for (const [capability, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
    if (includesPhrase(haystack, capability)) return capability;
    if (keywords.some((keyword) => includesPhrase(haystack, keyword))) return capability;
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function mitigationsForLevel(level: RiskLevel): string[] {
  if (level === "low") return ["Keep confirmation cards enabled for write or money actions."];
  if (level === "review_required") {
    return ["Review requested permissions before connecting.", "Require user confirmation before side effects."];
  }
  return [
    "Ask for only the scopes needed for this task.",
    "Require confirmation before any write, booking, message, order, or payment action.",
  ];
}

function capabilityLabel(capability: string): string {
  return capability.replace(/_/g, " ");
}

function terms(text: string): Set<string> {
  return new Set(normalizeText(text).split(/\s+/).filter(Boolean));
}

function includesPhrase(haystack: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  return new RegExp(`\\b${escapeRegExp(normalizedPhrase)}\\b`).test(haystack);
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
