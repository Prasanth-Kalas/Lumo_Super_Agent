/**
 * Lumo mission planning.
 *
 * This is the deterministic app-store preflight that runs before the LLM sees
 * tools. It detects which marketplace apps a user request needs, determines
 * whether the current user has installed/connected those apps, and returns the
 * explicit permission proposals the shell must render before continuing.
 */

import { createHash } from "node:crypto";
import type { AgentManifest } from "@lumo/agent-sdk";
import type { Registry, RegistryEntry } from "./agent-registry.js";
import type { AppInstall } from "./app-installs.js";
import type { ConnectionMeta } from "./connections.js";
import type { RankedAgentResult, RiskBadge } from "./marketplace-intelligence-core.js";
import { persistMission } from "./mission-execution.ts";
import type { TripOptimizationResult } from "./trip-optimization.js";

export type MissionAgentState =
  | "ready"
  | "not_installed"
  | "not_connected"
  | "unavailable";

export type MissionInstallAction =
  | "install"
  | "install_with_profile_permission"
  | "connect_oauth"
  | "grant_lumo_id";

export interface MissionScope {
  name: string;
  description: string;
  required: boolean;
}

export interface MissionAgentCandidate {
  agent_id: string;
  display_name: string;
  one_liner: string;
  domain: string;
  capability: string;
  capability_label: string;
  confidence: number;
  reason: string;
  marketplace_url: string;
  connect_model: AgentManifest["connect"]["model"];
  required_scopes: MissionScope[];
  pii_scope: AgentManifest["pii_scope"];
  requires_payment: boolean;
  health_score: number;
  rank_score: number | null;
  rank_reasons: string[];
  risk_badge: RiskBadge | null;
  state: MissionAgentState;
  state_reason: string;
  rollback?: {
    reversibility?: "reversible" | "compensating" | "irreversible";
    compensating_tool?: string;
    compensating_inputs_template?: Record<string, unknown>;
    compensating_window_seconds?: number;
  } | null;
}

export interface MissionInstallProposal extends MissionAgentCandidate {
  action: MissionInstallAction;
  can_auto_install: boolean;
  permission_title: string;
  permission_copy: string;
  profile_fields_requested: AgentManifest["pii_scope"];
}

export interface MissionUnavailableCapability {
  capability: string;
  capability_label: string;
  reason: string;
  requested_phrase: string;
}

export interface LumoMissionPlan {
  mission_id: string;
  original_request: string;
  mission_title: string;
  message: string;
  required_agents: MissionAgentCandidate[];
  ready_agents: MissionAgentCandidate[];
  install_proposals: MissionInstallProposal[];
  ranked_recommendations: RankedAgentResult[];
  trip_optimization?: TripOptimizationResult | null;
  user_questions: string[];
  confirmation_points: string[];
  unavailable_capabilities: MissionUnavailableCapability[];
  can_continue_now: boolean;
  should_pause_for_permission: boolean;
}

export interface BuildMissionPlanInput {
  request: string;
  registry: Registry;
  connections?: ConnectionMeta[];
  installs?: AppInstall[];
  user_id?: string | null;
  session_id?: string | null;
  ranked_agents?: RankedAgentResult[];
  risk_badges?: Record<string, RiskBadge> | Map<string, RiskBadge>;
  trip_optimization?: TripOptimizationResult | null;
}

interface CapabilityDefinition {
  id: string;
  label: string;
  keywords: string[];
  preferred_agent_ids: string[];
  reason: string;
}

const CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "flights",
    label: "Flights",
    keywords: [
      "flight",
      "flights",
      "fly",
      "flying",
      "airfare",
      "airport",
      "plane",
      "depart",
      "return flight",
      "round trip",
    ],
    preferred_agent_ids: ["flight"],
    reason: "The request asks for flight search, pricing, or booking.",
  },
  {
    id: "hotels",
    label: "Hotels",
    keywords: [
      "hotel",
      "hotels",
      "stay",
      "lodging",
      "room",
      "resort",
      "check in",
      "check-in",
      "check out",
      "check-out",
    ],
    preferred_agent_ids: ["hotel"],
    reason: "The request asks for lodging or room booking.",
  },
  {
    id: "food",
    label: "Food delivery",
    keywords: [
      "food",
      "order food",
      "delivery",
      "deliver",
      "doordash",
      "meal",
      "order lunch",
      "order dinner",
      "order breakfast",
      "takeout",
    ],
    preferred_agent_ids: ["food"],
    reason: "The request asks for food delivery or order placement.",
  },
  {
    id: "restaurants",
    label: "Restaurant reservations",
    keywords: [
      "restaurant",
      "restaurants",
      "reservation",
      "reserve",
      "table",
      "dining",
      "book dinner",
      "book lunch",
      "opentable",
    ],
    preferred_agent_ids: ["restaurant"],
    reason: "The request asks for restaurant discovery or reservations.",
  },
  {
    id: "weather",
    label: "Weather",
    keywords: [
      "weather",
      "forecast",
      "rain",
      "temperature",
      "storm",
      "snow",
      "heat",
      "cold",
    ],
    preferred_agent_ids: ["open-weather"],
    reason: "The request needs forecast or weather context.",
  },
  {
    id: "maps",
    label: "Maps and routes",
    keywords: [
      "map",
      "maps",
      "route",
      "routes",
      "directions",
      "drive",
      "driving",
      "distance",
      "traffic",
      "nearby",
      "where is",
    ],
    preferred_agent_ids: ["open-maps"],
    reason: "The request needs geocoding, distance, or route planning.",
  },
  {
    id: "ev_charging",
    label: "EV charging",
    keywords: [
      "ev",
      "electric vehicle",
      "charge",
      "charger",
      "chargers",
      "charging",
      "tesla charger",
      "ccs",
      "chademo",
    ],
    preferred_agent_ids: ["open-ev-charging"],
    reason: "The request needs EV charger discovery.",
  },
  {
    id: "events",
    label: "Events",
    keywords: [
      "event",
      "events",
      "concert",
      "concerts",
      "show",
      "shows",
      "festival",
      "festivals",
      "game",
      "games",
      "tickets",
      "things happening",
    ],
    preferred_agent_ids: ["open-events"],
    reason: "The request asks for events or activities happening nearby.",
  },
  {
    id: "attractions",
    label: "Attractions",
    keywords: [
      "attraction",
      "attractions",
      "sightseeing",
      "landmark",
      "landmarks",
      "tour",
      "tours",
      "things to do",
      "places to visit",
      "activities",
    ],
    preferred_agent_ids: ["open-attractions"],
    reason: "The request asks for places to visit or trip activities.",
  },
  {
    id: "ground_transport",
    label: "Ground transport",
    keywords: [
      "cab",
      "cabs",
      "taxi",
      "taxis",
      "uber",
      "lyft",
      "ride hailing",
      "rideshare",
      "car service",
      "airport transfer",
    ],
    preferred_agent_ids: ["open-maps"],
    reason:
      "The request asks for ground transportation. Open Maps can plan routes, but booking a ride requires a partner ride-hailing app.",
  },
];

const MIN_CONFIDENCE = 0.24;
const MIN_HEALTH_SCORE = 0.6;

export function buildLumoMissionPlan(
  input: BuildMissionPlanInput,
): LumoMissionPlan {
  const request = input.request.trim();
  const detected = detectCapabilities(request);
  const connections = input.connections ?? [];
  const installs = input.installs ?? [];
  const connectedAgentIds = new Set(
    connections.filter((c) => c.status === "active").map((c) => c.agent_id),
  );
  const installedAgentIds = new Set(
    installs.filter((i) => i.status === "installed").map((i) => i.agent_id),
  );
  const toolTextByAgent = buildToolTextByAgent(input.registry);
  const required_agents: MissionAgentCandidate[] = [];
  const unavailable_capabilities: MissionUnavailableCapability[] = [];
  const rankedByAgentId = new Map(
    (input.ranked_agents ?? []).map((agent) => [agent.agent_id, agent]),
  );
  const riskByAgentId =
    input.risk_badges instanceof Map
      ? input.risk_badges
      : new Map(Object.entries(input.risk_badges ?? {}));

  for (const capability of detected) {
    if (capability.id === "ground_transport") {
      unavailable_capabilities.push({
        capability: "ride_hailing_booking",
        capability_label: "Ride-hailing booking",
        requested_phrase: "cab/taxi/ride request",
        reason:
          "No approved ride-hailing booking app is installed in this marketplace yet. I can use Open Maps for pickup/drop-off route planning, then hand off booking once a ride-hailing partner is approved.",
      });
    }

    const candidate = bestAgentForCapability(
      capability,
      input.registry,
      toolTextByAgent,
      request,
      connectedAgentIds,
      installedAgentIds,
      input.user_id,
      rankedByAgentId,
      riskByAgentId,
    );
    if (candidate) required_agents.push(candidate);
  }

  const dedupedAgents = dedupeByAgentAndCapability(required_agents);
  const ready_agents = dedupedAgents.filter((a) => a.state === "ready");
  const install_proposals = dedupedAgents
    .filter((a) => a.state !== "ready" && a.state !== "unavailable")
    .map(toInstallProposal);

  const mission_id = stableMissionId(request, dedupedAgents, unavailable_capabilities);
  const mission_title = inferMissionTitle(request, dedupedAgents);
  const continueApproved = isMissionContinueApproval(request);
  const should_pause_for_permission =
    install_proposals.length > 0 ||
    (unavailable_capabilities.length > 0 && !continueApproved);
  const can_continue_now =
    !should_pause_for_permission &&
    (unavailable_capabilities.length === 0 || continueApproved);
  const message = buildMissionMessage({
    mission_title,
    ready_agents,
    install_proposals,
    unavailable_capabilities,
  });
  const ranked_recommendations = (input.ranked_agents ?? [])
    .filter((agent) => agent.score >= 0.2)
    .slice(0, 8);
  const user_questions = questionsForMission(request, dedupedAgents);
  const confirmation_points = confirmationPointsForMission(dedupedAgents);

  const plan: LumoMissionPlan = {
    mission_id,
    original_request: request,
    mission_title,
    message,
    required_agents: dedupedAgents,
    ready_agents,
    install_proposals,
    ranked_recommendations,
    trip_optimization: input.trip_optimization ?? null,
    user_questions,
    confirmation_points,
    unavailable_capabilities,
    can_continue_now,
    should_pause_for_permission,
  };
  persistMissionBestEffort(plan, input);
  return plan;
}

function persistMissionBestEffort(
  plan: LumoMissionPlan,
  input: BuildMissionPlanInput,
): void {
  if (!input.user_id || input.user_id === "anon") return;
  if (!input.session_id) return;
  if (plan.required_agents.length === 0) return;
  void persistMission(plan, input.user_id, input.session_id).catch((err) => {
    console.warn("[lumo-mission] durable mission persistence failed", {
      mission_id: plan.mission_id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function detectCapabilities(request: string): CapabilityDefinition[] {
  const normalized = normalizeText(request);
  if (!normalized) return [];
  const detected = CAPABILITIES.filter((capability) =>
    capability.keywords.some((keyword) => includesPhrase(normalized, keyword)),
  );
  if (!isBroadTripPlanningRequest(normalized)) return detected;

  const ids = new Set(detected.map((capability) => capability.id));
  for (const id of ["flights", "hotels", "attractions", "events"]) ids.add(id);
  if (/\b(from|drive|driving|route|routes|cab|taxi|airport transfer)\b/.test(normalized)) {
    ids.add("maps");
  }
  return CAPABILITIES.filter((capability) => ids.has(capability.id));
}

function isBroadTripPlanningRequest(normalized: string): boolean {
  return (
    includesPhrase(normalized, "plan a trip") ||
    includesPhrase(normalized, "plan my trip") ||
    includesPhrase(normalized, "trip to") ||
    includesPhrase(normalized, "travel to") ||
    includesPhrase(normalized, "vacation") ||
    includesPhrase(normalized, "getaway") ||
    includesPhrase(normalized, "visit vegas") ||
    includesPhrase(normalized, "going to vegas") ||
    includesPhrase(normalized, "going to las vegas")
  );
}

function isMissionContinueApproval(request: string): boolean {
  const normalized = normalizeText(request);
  return (
    includesPhrase(normalized, "continue planning this mission with approved apps") ||
    includesPhrase(normalized, "continue planning this trip with approved apps") ||
    includesPhrase(normalized, "continue with available approved apps") ||
    includesPhrase(normalized, "skip unavailable marketplace capabilities") ||
    includesPhrase(normalized, "continue with the parts")
  );
}

function bestAgentForCapability(
  capability: CapabilityDefinition,
  registry: Registry,
  toolTextByAgent: Map<string, string>,
  request: string,
  connectedAgentIds: ReadonlySet<string>,
  installedAgentIds: ReadonlySet<string>,
  user_id: string | null | undefined,
  rankedByAgentId: ReadonlyMap<string, RankedAgentResult>,
  riskByAgentId: ReadonlyMap<string, RiskBadge>,
): MissionAgentCandidate | null {
  let best: { entry: RegistryEntry; score: number } | null = null;
  for (const entry of Object.values(registry.agents)) {
    const score = scoreAgentForCapability(
      entry,
      capability,
      toolTextByAgent.get(entry.manifest.agent_id) ?? "",
      request,
    );
    if (score < MIN_CONFIDENCE) continue;
    if (!best || score > best.score) best = { entry, score };
  }
  if (!best) return null;

  const { entry, score } = best;
  const state = stateForAgent(
    entry,
    connectedAgentIds,
    installedAgentIds,
    user_id,
  );
  const manifest = entry.manifest;
  const rankHint = rankedByAgentId.get(manifest.agent_id) ?? null;
  const rollback = rollbackMetadataForAgent(registry, manifest.agent_id);

  return {
    agent_id: manifest.agent_id,
    display_name: manifest.display_name,
    one_liner: manifest.one_liner,
    domain: manifest.domain,
    capability: capability.id,
    capability_label: capability.label,
    confidence: roundConfidence(score),
    reason: capability.reason,
    marketplace_url: `/marketplace/${manifest.agent_id}`,
    connect_model: manifest.connect.model,
    required_scopes: requiredScopes(manifest),
    pii_scope: manifest.pii_scope,
    requires_payment: manifest.requires_payment,
    health_score: entry.health_score,
    rank_score: rankHint?.score ?? null,
    rank_reasons: rankHint?.reasons ?? [],
    risk_badge: riskByAgentId.get(manifest.agent_id) ?? null,
    state: state.state,
    state_reason: state.reason,
    rollback,
  };
}

function scoreAgentForCapability(
  entry: RegistryEntry,
  capability: CapabilityDefinition,
  toolText: string,
  request: string,
): number {
  const manifest = entry.manifest;
  const normalizedRequest = normalizeText(request);
  const haystack = normalizeText(
    [
      manifest.agent_id,
      manifest.display_name,
      manifest.domain,
      manifest.one_liner,
      ...manifest.intents,
      ...manifest.example_utterances,
      toolText,
    ].join(" "),
  );

  let score = 0;
  if (capability.preferred_agent_ids.includes(manifest.agent_id)) score += 0.65;
  if (includesPhrase(haystack, capability.id.replace(/_/g, " "))) score += 0.12;
  if (includesPhrase(haystack, manifest.domain)) score += 0.04;

  for (const keyword of capability.keywords) {
    if (includesPhrase(haystack, keyword)) score += 0.045;
    if (includesPhrase(normalizedRequest, keyword)) score += 0.015;
  }
  if (entry.health_score < MIN_HEALTH_SCORE) score -= 0.35;
  return Math.max(0, Math.min(1, score));
}

function stateForAgent(
  entry: RegistryEntry,
  connectedAgentIds: ReadonlySet<string>,
  installedAgentIds: ReadonlySet<string>,
  user_id: string | null | undefined,
): { state: MissionAgentState; reason: string } {
  if (entry.health_score < MIN_HEALTH_SCORE) {
    return {
      state: "unavailable",
      reason: "This marketplace app is below the health threshold.",
    };
  }

  const agentId = entry.manifest.agent_id;
  if (connectedAgentIds.has(agentId)) {
    return { state: "ready", reason: "Connected and ready to use." };
  }
  if (installedAgentIds.has(agentId)) {
    return { state: "ready", reason: "Installed and ready to use." };
  }

  const isAnon = !user_id || user_id === "anon";
  if (isAnon && entry.manifest.connect.model === "none") {
    return {
      state: "ready",
      reason: "Public demo mode can use this app without an install.",
    };
  }

  if (entry.manifest.connect.model === "oauth2") {
    return {
      state: "not_connected",
      reason: "This app needs account connection before Lumo can use it.",
    };
  }
  return {
    state: "not_installed",
    reason: "This app must be installed from the marketplace first.",
  };
}

function toInstallProposal(
  candidate: MissionAgentCandidate,
): MissionInstallProposal {
  const hasProfileFields = candidate.pii_scope.length > 0;
  const action: MissionInstallAction =
    candidate.connect_model === "oauth2"
      ? "connect_oauth"
      : candidate.connect_model === "lumo_id"
        ? "grant_lumo_id"
        : hasProfileFields || candidate.requires_payment
          ? "install_with_profile_permission"
          : "install";

  const profileCopy =
    candidate.pii_scope.length > 0
      ? `It may receive these profile fields only when a tool needs them: ${candidate.pii_scope.join(", ")}.`
      : "It does not request profile fields.";
  const paymentCopy = candidate.requires_payment
    ? "Money-moving actions still require the normal confirmation card before dispatch."
    : "It cannot move money.";
  const scopeCopy =
    candidate.required_scopes.length > 0
      ? `Connection scopes: ${candidate.required_scopes.map((s) => s.name).join(", ")}.`
      : "";

  return {
    ...candidate,
    action,
    can_auto_install: action !== "connect_oauth",
    permission_title:
      action === "connect_oauth"
        ? `Connect ${candidate.display_name}`
        : `Install ${candidate.display_name}`,
    permission_copy: [profileCopy, paymentCopy, scopeCopy].filter(Boolean).join(" "),
    profile_fields_requested: candidate.pii_scope,
  };
}

function buildToolTextByAgent(registry: Registry): Map<string, string> {
  const byAgent = new Map<string, string[]>();
  for (const tool of registry.bridge.tools as Array<{
    name: string;
    description?: string;
  }>) {
    const routing = registry.bridge.routing[tool.name];
    if (!routing) continue;
    const chunks = byAgent.get(routing.agent_id) ?? [];
    chunks.push(tool.name, tool.description ?? "");
    byAgent.set(routing.agent_id, chunks);
  }
  return new Map(Array.from(byAgent, ([agentId, chunks]) => [agentId, chunks.join(" ")]));
}

function rollbackMetadataForAgent(
  registry: Registry,
  agent_id: string,
): MissionAgentCandidate["rollback"] {
  const entries = Object.values(registry.bridge.routing).filter(
    (routing) => routing.agent_id === agent_id,
  ) as Array<{
    operation_id: string;
    cost_tier?: string;
    reversibility?: "reversible" | "compensating" | "irreversible";
    compensating_tool?: string;
    compensating_inputs_template?: Record<string, unknown>;
    compensating_window_seconds?: number;
    cancels?: string;
  }>;
  const compensating =
    entries.find((entry) => entry.reversibility === "compensating" && entry.compensating_tool) ??
    entries.find((entry) => entry.cost_tier === "money" && (entry.compensating_tool || entry.cancels));
  if (!compensating) return null;
  return {
    reversibility: compensating.reversibility ?? "compensating",
    compensating_tool: compensating.compensating_tool ?? compensating.cancels,
    compensating_inputs_template:
      compensating.compensating_inputs_template ??
      defaultCompensatingInputsTemplate(compensating.operation_id),
    compensating_window_seconds: compensating.compensating_window_seconds,
  };
}

function defaultCompensatingInputsTemplate(operationId: string): Record<string, unknown> {
  return {
    booking_id: "{{outputs.booking_id}}",
    order_id: "{{outputs.order_id}}",
    reservation_id: "{{outputs.reservation_id}}",
    original_operation_id: operationId,
  };
}

function requiredScopes(manifest: AgentManifest): MissionScope[] {
  if (manifest.connect.model !== "oauth2") return [];
  return manifest.connect.scopes
    .filter((scope) => scope.required)
    .map((scope) => ({
      name: scope.name,
      description: scope.description,
      required: scope.required,
    }));
}

function dedupeByAgentAndCapability(
  agents: MissionAgentCandidate[],
): MissionAgentCandidate[] {
  const seen = new Set<string>();
  const out: MissionAgentCandidate[] = [];
  for (const agent of agents.sort((a, b) => b.confidence - a.confidence)) {
    const key = `${agent.agent_id}:${agent.capability}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(agent);
  }
  return out.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

function buildMissionMessage(input: {
  mission_title: string;
  ready_agents: MissionAgentCandidate[];
  install_proposals: MissionInstallProposal[];
  unavailable_capabilities: MissionUnavailableCapability[];
}): string {
  if (input.install_proposals.length > 0) {
    const names = input.install_proposals.map((p) => p.display_name).join(", ");
    return `I found the right marketplace app${input.install_proposals.length === 1 ? "" : "s"} for ${input.mission_title}: ${names}. I need your permission before I install or connect ${input.install_proposals.length === 1 ? "it" : "them"} and share any allowed profile details.`;
  }
  if (input.unavailable_capabilities.length > 0) {
    return `I can start the parts of ${input.mission_title} that are available, but one requested capability is not in the marketplace yet.`;
  }
  if (input.ready_agents.length > 0) {
    return `The needed apps are already ready for ${input.mission_title}.`;
  }
  return "I did not find a marketplace app match for that request yet.";
}

function questionsForMission(
  request: string,
  agents: MissionAgentCandidate[],
): string[] {
  const normalized = normalizeText(request);
  const questions: string[] = [];
  const hasDeparture = /\b(from|departing from|leaving from)\b/.test(normalized);
  const hasBroadDepartureOnly =
    /\b(from|departing from|leaving from)\s+(california|ca)\b/.test(normalized);
  if (
    agents.some((agent) => agent.capability === "flights") &&
    (!hasDeparture || hasBroadDepartureOnly)
  ) {
    questions.push(
      hasBroadDepartureOnly
        ? "Which California city or airport should I use for departure?"
        : "What departure city or airport should I use?",
    );
  }
  if (agents.some((agent) => agent.capability === "flights" || agent.capability === "hotels")) {
    questions.push("How many travelers should I plan for?");
    questions.push("Should I optimize for cheapest, fastest, or most comfortable options?");
  }
  if (agents.some((agent) => agent.capability === "hotels")) {
    questions.push("What hotel budget and preferred area should I use?");
  }
  if (agents.some((agent) => agent.capability === "ev_charging")) {
    questions.push("What EV connector or vehicle should I optimize charging stops for?");
  }
  return dedupeStrings(questions).slice(0, 5);
}

function confirmationPointsForMission(
  agents: MissionAgentCandidate[],
): string[] {
  const points = new Set<string>();
  if (agents.some((agent) => agent.capability === "flights")) {
    points.add("Confirm flight itinerary, travelers, bags, and total fare before booking.");
  }
  if (agents.some((agent) => agent.capability === "hotels")) {
    points.add("Confirm hotel dates, room type, fees, and cancellation policy before booking.");
  }
  if (agents.some((agent) => agent.capability === "food" || agent.capability === "restaurants")) {
    points.add("Confirm order, reservation time, party size, and total before dispatch.");
  }
  if (agents.some((agent) => agent.requires_payment)) {
    points.add("Confirm every payment or money-moving action in a Lumo confirmation card.");
  }
  points.add("Ask before creating accounts, sharing profile details, sending messages, or committing bookings.");
  return Array.from(points);
}

function inferMissionTitle(
  request: string,
  agents: MissionAgentCandidate[],
): string {
  const destination = inferDestination(request);
  if (destination && agents.some((a) => a.capability === "flights" || a.capability === "hotels")) {
    return `your ${destination} trip`;
  }
  if (agents.length === 1) return agents[0]?.capability_label.toLowerCase() ?? "this task";
  if (agents.length > 1) return "this multi-app task";
  return "this request";
}

function inferDestination(request: string): string | null {
  const normalized = request.toLowerCase();
  if (/\b(las vegas|vegas)\b/.test(normalized)) return "Vegas";
  const toMatch = /\bto\s+([a-z][a-z\s]{2,24})(?:\s+from|\s+for|\s+next|\s+and|\s*$)/i.exec(request);
  if (!toMatch?.[1]) return null;
  return titleCase(toMatch[1].trim());
}

function stableMissionId(
  request: string,
  agents: MissionAgentCandidate[],
  unavailable: MissionUnavailableCapability[],
): string {
  const hash = createHash("sha256")
    .update(request)
    .update(agents.map((a) => `${a.agent_id}:${a.capability}:${a.state}`).join("|"))
    .update(unavailable.map((u) => u.capability).join("|"))
    .digest("hex")
    .slice(0, 16);
  return `mission_${hash}`;
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

function roundConfidence(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function titleCase(input: string): string {
  return input.replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
