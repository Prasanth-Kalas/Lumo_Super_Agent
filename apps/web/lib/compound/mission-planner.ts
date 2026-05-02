import { createHash } from "node:crypto";
import { stableStringify } from "./persistence.ts";

export const COMPOUND_MISSION_AGENT_IDS = [
  "lumo-flights",
  "lumo-hotels",
  "lumo-restaurants",
  "lumo-food",
] as const;

export type CompoundMissionAgentId = typeof COMPOUND_MISSION_AGENT_IDS[number];

export type CompoundMissionToolName =
  | "mission.flight_search"
  | "mission.hotel_search"
  | "mission.restaurant_search"
  | "mission.food_search";

export type CompoundDispatchToolName =
  | "duffel_search_flights"
  | "hotel_search"
  | "restaurant_check_availability"
  | "food_search"
  | "food_get_restaurant_menu";

export type CompoundMissionEdgeType =
  | "requires_arrival_time"
  | "requires_destination"
  | "requires_dates"
  | "requires_user_confirmation"
  | "custom";

export interface CompoundMissionLeg {
  client_step_id: string;
  agent_id: CompoundMissionAgentId;
  mission_tool_name: CompoundMissionToolName;
  dispatch_tool_name: CompoundDispatchToolName;
  description: string;
  line_items_hint: Record<string, unknown>;
}

export interface CompoundMissionDependency {
  dependency_step_id: string;
  dependent_step_id: string;
  edge_type: CompoundMissionEdgeType;
}

export interface CompoundMissionPlan {
  mission_id?: string;
  announcement: string;
  legs: CompoundMissionLeg[];
  dependencies: CompoundMissionDependency[];
  compose_step: {
    client_step_id: "compose_reply";
    depends_on: string[];
  };
  graph_hash: string;
  source: "heuristic_high_confidence" | "heuristic_llm_confirmed";
}

export interface CompoundMissionDetection {
  compound: boolean;
  confidence: number;
  domains: CompoundMissionDomain[];
  reason: string;
  requires_llm_confirmation: boolean;
}

export type CompoundMissionDomain = "flights" | "hotels" | "restaurants" | "food";

export interface BuildCompoundMissionPlanInput {
  message: string;
  now?: Date;
  userRegion?: string;
}

interface ProviderConfig {
  provider: "groq" | "cerebras";
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

interface BuildCompoundMissionPlanOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  providers?: ProviderConfig[];
}

interface CompoundIntentLLMDecision {
  decision: "compound" | "single_agent" | "clarify" | "unsupported";
  confidence: number;
  domains: CompoundMissionDomain[];
  reason: string;
}

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 900;

const AIRPORTS_BY_CITY = new Map<string, string>([
  ["chicago", "ORD"],
  ["ord", "ORD"],
  ["midway", "MDW"],
  ["vegas", "LAS"],
  ["las vegas", "LAS"],
  ["las", "LAS"],
  ["nyc", "JFK"],
  ["new york", "JFK"],
  ["miami", "MIA"],
  ["beach", "MIA"],
  ["paris", "CDG"],
  ["aspen", "ASE"],
  ["denver", "DEN"],
  ["ski", "DEN"],
]);

const DESTINATION_LABELS = new Map<string, string>([
  ["LAS", "Las Vegas"],
  ["JFK", "New York"],
  ["MIA", "Miami"],
  ["CDG", "Paris"],
  ["ASE", "Aspen"],
  ["DEN", "Denver"],
]);

export function detectCompoundMissionIntent(message: string): CompoundMissionDetection {
  const text = normalizeText(message);
  if (!text) {
    return {
      compound: false,
      confidence: 0,
      domains: [],
      reason: "empty_message",
      requires_llm_confirmation: false,
    };
  }

  const domains = detectDomains(text);
  const broadTrip =
    /\b(plan|organize|arrange|build)\b/.test(text) &&
    /\b(trip|travel|vacation|weekend|getaway|tour|week)\b/.test(text);
  const multiNeed =
    /\b(including|with|plus|and)\b/.test(text) &&
    domains.length >= 2;
  const compound = domains.length >= 2 && (broadTrip || multiNeed);
  const confidence = compound
    ? Math.min(0.98, 0.62 + domains.length * 0.12 + (broadTrip ? 0.12 : 0))
    : domains.length >= 2
      ? 0.58
      : 0.18;

  return {
    compound: compound && confidence >= 0.7,
    confidence,
    domains,
    reason: compound
      ? `Detected ${domains.join(", ")} in a broad trip request.`
      : domains.length >= 2
        ? "Multiple domains detected, but phrasing is not clearly a compound trip."
        : "Not enough specialist domains for compound dispatch.",
    requires_llm_confirmation: confidence > 0.5 && confidence < 0.82,
  };
}

export function buildCompoundMissionPlan(
  input: BuildCompoundMissionPlanInput,
): CompoundMissionPlan | null {
  const detection = detectCompoundMissionIntent(input.message);
  if (!detection.compound) return null;
  return buildPlanFromDomains(
    input,
    detection.domains,
    detection.requires_llm_confirmation
      ? "heuristic_llm_confirmed"
      : "heuristic_high_confidence",
  );
}

export async function buildCompoundMissionPlanWithConfirmation(
  input: BuildCompoundMissionPlanInput,
  options: BuildCompoundMissionPlanOptions = {},
): Promise<CompoundMissionPlan | null> {
  const detection = detectCompoundMissionIntent(input.message);
  if (detection.compound && !detection.requires_llm_confirmation) {
    return buildPlanFromDomains(input, detection.domains, "heuristic_high_confidence");
  }
  if (detection.confidence < 0.5 && !detection.requires_llm_confirmation) {
    return null;
  }
  const confirmed = await confirmCompoundIntent(input.message, detection, options);
  if (!confirmed || confirmed.decision !== "compound" || confirmed.confidence < 0.7) {
    return detection.compound
      ? buildPlanFromDomains(input, detection.domains, "heuristic_high_confidence")
      : null;
  }
  const domains = confirmed.domains.filter((domain) =>
    ["flights", "hotels", "restaurants", "food"].includes(domain),
  );
  if (domains.length < 2) return null;
  return buildPlanFromDomains(input, domains, "heuristic_llm_confirmed");
}

function buildPlanFromDomains(
  input: BuildCompoundMissionPlanInput,
  domains: CompoundMissionDomain[],
  source: CompoundMissionPlan["source"],
): CompoundMissionPlan {
  const now = input.now ?? new Date();
  const route = extractRoute(input.message);
  const dates = extractDateWindow(input.message, now);
  const destinationCode = route.destination ?? inferDestinationFromText(input.message) ?? "LAS";
  const originCode = route.origin ?? (domains.includes("flights") ? "ORD" : null);
  const destinationLabel = DESTINATION_LABELS.get(destinationCode) ?? destinationCode;
  const legs: CompoundMissionLeg[] = [];

  for (const domain of Array.from(new Set(domains)).slice(0, 4)) {
    if (domain === "flights") {
      legs.push({
        client_step_id: "flight_search",
        agent_id: "lumo-flights",
        mission_tool_name: "mission.flight_search",
        dispatch_tool_name: "duffel_search_flights",
        description: `Searching flights ${originCode ?? "origin"} -> ${destinationCode}`,
        line_items_hint: {
          origin: originCode,
          destination: destinationCode,
          departDate: dates.departDate,
          returnDate: dates.returnDate,
          passengers: 1,
          cabinClass: "economy",
        },
      });
      continue;
    }
    if (domain === "hotels") {
      legs.push({
        client_step_id: "hotel_search",
        agent_id: "lumo-hotels",
        mission_tool_name: "mission.hotel_search",
        dispatch_tool_name: "hotel_search",
        description: `Searching hotels in ${destinationLabel}`,
        line_items_hint: {
          destination: destinationLabel,
          check_in: dates.departDate,
          check_out: dates.returnDate,
          guests: 1,
          rooms: 1,
        },
      });
      continue;
    }
    if (domain === "restaurants") {
      legs.push({
        client_step_id: "restaurant_search",
        agent_id: "lumo-restaurants",
        mission_tool_name: "mission.restaurant_search",
        dispatch_tool_name: "restaurant_check_availability",
        description: `Checking dinner availability in ${destinationLabel}`,
        line_items_hint: {
          destination: destinationLabel,
          date: dates.departDate,
          party_size: 1,
          meal: "dinner",
        },
      });
      continue;
    }
    legs.push({
      client_step_id: "food_search",
      agent_id: "lumo-food",
      mission_tool_name: "mission.food_search",
      dispatch_tool_name: "food_search",
      description: `Finding food options in ${destinationLabel}`,
      line_items_hint: {
        destination: destinationLabel,
        query: "local food options",
        party_size: 1,
      },
    });
  }

  const dependencies = dependenciesForLegs(legs);
  validateCompoundMissionPlan({ legs, dependencies });
  const graphHash = hashCompoundMissionGraph(legs, dependencies);
  return {
    announcement: announcementForPlan(destinationLabel, legs),
    legs,
    dependencies,
    compose_step: {
      client_step_id: "compose_reply",
      depends_on: legs.map((leg) => leg.client_step_id).sort(),
    },
    graph_hash: graphHash,
    source,
  };
}

async function confirmCompoundIntent(
  message: string,
  detection: CompoundMissionDetection,
  options: BuildCompoundMissionPlanOptions,
): Promise<CompoundIntentLLMDecision | null> {
  const providers = options.providers ?? defaultConfirmationProviders();
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const provider of providers) {
    if (!provider.apiKey || !provider.model) continue;
    try {
      const raw = await callConfirmationProvider({
        provider,
        message,
        detection,
        fetchImpl,
        timeoutMs: options.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS,
      });
      const parsed = parseJsonObject(raw);
      if (!parsed) continue;
      const decision = normalizeLlmDecision(parsed);
      if (decision) return decision;
    } catch {
      continue;
    }
  }
  return null;
}

function defaultConfirmationProviders(): ProviderConfig[] {
  return [
    {
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: process.env.LUMO_GROQ_API_KEY,
      model: process.env.LUMO_GROQ_REFLEX_MODEL ?? "llama-3.1-8b-instant",
    },
    {
      provider: "cerebras",
      baseUrl: "https://api.cerebras.ai/v1/chat/completions",
      apiKey: process.env.LUMO_CEREBRAS_API_KEY,
      model: process.env.LUMO_CEREBRAS_REFLEX_MODEL ?? "llama-3.1-8b",
    },
  ];
}

async function callConfirmationProvider(input: {
  provider: ProviderConfig;
  message: string;
  detection: CompoundMissionDetection;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.provider.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.provider.apiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.provider.model,
        temperature: 0,
        max_tokens: 140,
        messages: [
          {
            role: "system",
            content: [
              "Classify whether a Lumo request is a compound trip mission.",
              "Return JSON only: {\"decision\":\"compound|single_agent|clarify|unsupported\",\"confidence\":0-1,\"domains\":[\"flights|hotels|restaurants|food\"],\"reason\":\"short\"}.",
              "compound requires at least two supported domains.",
              "single_agent is for only flights, only hotels, only dinner, or only food.",
              "clarify is for trip requests missing destination or timing.",
              "unsupported is for providers outside flights, hotels, restaurants, and food.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              message: input.message.slice(0, 800),
              heuristic_domains: input.detection.domains,
              heuristic_confidence: input.detection.confidence,
              heuristic_reason: input.detection.reason,
            }),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`compound_confirm_${input.provider.provider}_${response.status}`);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLlmDecision(raw: Record<string, unknown>): CompoundIntentLLMDecision | null {
  const decision = raw["decision"];
  if (
    decision !== "compound" &&
    decision !== "single_agent" &&
    decision !== "clarify" &&
    decision !== "unsupported"
  ) {
    return null;
  }
  const confidence = typeof raw["confidence"] === "number"
    ? Math.max(0, Math.min(1, raw["confidence"]))
    : 0;
  const domains = Array.isArray(raw["domains"])
    ? raw["domains"].filter(isCompoundMissionDomain)
    : [];
  const reason = typeof raw["reason"] === "string" ? raw["reason"].slice(0, 240) : "";
  return { decision, confidence, domains, reason };
}

export function validateCompoundMissionPlan(input: {
  legs: CompoundMissionLeg[];
  dependencies: CompoundMissionDependency[];
}): void {
  if (input.legs.length < 2) throw new Error("compound_plan_requires_two_legs");
  if (input.legs.length > 4) throw new Error("compound_plan_too_many_legs");
  const legIds = new Set<string>();
  for (const leg of input.legs) {
    if (legIds.has(leg.client_step_id)) throw new Error("duplicate_compound_step_id");
    legIds.add(leg.client_step_id);
    if (!COMPOUND_MISSION_AGENT_IDS.includes(leg.agent_id)) {
      throw new Error(`unsupported_compound_agent:${leg.agent_id}`);
    }
    if (!missionToolMatchesDispatch(leg.mission_tool_name, leg.dispatch_tool_name)) {
      throw new Error(`unsupported_compound_dispatch:${leg.mission_tool_name}`);
    }
  }
  for (const edge of input.dependencies) {
    if (!legIds.has(edge.dependency_step_id) || !legIds.has(edge.dependent_step_id)) {
      throw new Error("missing_compound_dependency_step");
    }
    if (edge.dependency_step_id === edge.dependent_step_id) {
      throw new Error("self_compound_dependency");
    }
  }
  if (hasCycle(input.legs.map((leg) => leg.client_step_id), input.dependencies)) {
    throw new Error("cyclic_compound_mission_graph");
  }
}

export function hashCompoundMissionGraph(
  legs: CompoundMissionLeg[],
  dependencies: CompoundMissionDependency[],
): string {
  const normalized = {
    legs: legs
      .slice()
      .sort((a, b) => a.client_step_id.localeCompare(b.client_step_id))
      .map((leg) => ({
        client_step_id: leg.client_step_id,
        agent_id: leg.agent_id,
        mission_tool_name: leg.mission_tool_name,
        dispatch_tool_name: leg.dispatch_tool_name,
        description: leg.description,
        line_items_hint: leg.line_items_hint,
      })),
    dependencies: dependencies
      .slice()
      .sort((a, b) =>
        [
          a.dependency_step_id.localeCompare(b.dependency_step_id),
          a.dependent_step_id.localeCompare(b.dependent_step_id),
          a.edge_type.localeCompare(b.edge_type),
        ].find((result) => result !== 0) ?? 0,
      ),
  };
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

function detectDomains(text: string): CompoundMissionDomain[] {
  const domains: CompoundMissionDomain[] = [];
  const hasRoute = /\bfrom\b.+\bto\b|\bflight|flights|fly|airfare|airport\b/.test(text);
  const broadTrip = /\btrip|travel|vacation|weekend|getaway|tour|week\b/.test(text);
  if (hasRoute || (broadTrip && /\bvegas|las vegas|paris|beach|ski|aspen|nyc|new york\b/.test(text))) {
    domains.push("flights");
  }
  if (/\bhotel|hotels|stay|lodging|room|resort|lodging|entire week|weekend|ski week\b/.test(text)) {
    domains.push("hotels");
  }
  if (/\brestaurant|restaurants|reservation|reservations|dinner|lunch|table|food tour\b/.test(text)) {
    domains.push("restaurants");
  }
  if (/\bfood delivery|order food|takeout|doordash|meal delivery\b/.test(text)) {
    domains.push("food");
  }
  return Array.from(new Set(domains));
}

function dependenciesForLegs(legs: CompoundMissionLeg[]): CompoundMissionDependency[] {
  const ids = new Set(legs.map((leg) => leg.client_step_id));
  const dependencies: CompoundMissionDependency[] = [];
  if (ids.has("flight_search") && ids.has("hotel_search")) {
    dependencies.push({
      dependency_step_id: "flight_search",
      dependent_step_id: "hotel_search",
      edge_type: "requires_destination",
    });
  }
  if (ids.has("flight_search") && ids.has("restaurant_search")) {
    dependencies.push({
      dependency_step_id: "flight_search",
      dependent_step_id: "restaurant_search",
      edge_type: "requires_arrival_time",
    });
  }
  if (ids.has("hotel_search") && ids.has("restaurant_search")) {
    dependencies.push({
      dependency_step_id: "hotel_search",
      dependent_step_id: "restaurant_search",
      edge_type: "requires_dates",
    });
  }
  if (ids.has("flight_search") && ids.has("food_search")) {
    dependencies.push({
      dependency_step_id: "flight_search",
      dependent_step_id: "food_search",
      edge_type: "requires_destination",
    });
  }
  return dependencies;
}

function missionToolMatchesDispatch(
  missionToolName: CompoundMissionToolName,
  dispatchToolName: CompoundDispatchToolName,
): boolean {
  return (
    (missionToolName === "mission.flight_search" && dispatchToolName === "duffel_search_flights") ||
    (missionToolName === "mission.hotel_search" && dispatchToolName === "hotel_search") ||
    (missionToolName === "mission.restaurant_search" && dispatchToolName === "restaurant_check_availability") ||
    (missionToolName === "mission.food_search" &&
      (dispatchToolName === "food_search" || dispatchToolName === "food_get_restaurant_menu"))
  );
}

function hasCycle(
  stepIds: string[],
  dependencies: CompoundMissionDependency[],
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const edge of dependencies) {
    const list = outgoing.get(edge.dependency_step_id) ?? [];
    list.push(edge.dependent_step_id);
    outgoing.set(edge.dependency_step_id, list);
  }
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return stepIds.some(visit);
}

function extractRoute(message: string): { origin: string | null; destination: string | null } {
  const lower = normalizeText(message);
  const fromTo = /\bfrom\s+([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s+(?:next|this|for|including|with|and|on|in)\b|$)/.exec(lower);
  if (fromTo) {
    return {
      origin: airportForCity(fromTo[1]),
      destination: airportForCity(fromTo[2]),
    };
  }
  return { origin: null, destination: inferDestinationFromText(message) };
}

function inferDestinationFromText(message: string): string | null {
  const lower = normalizeText(message);
  const toMatch = /\b(?:to|in)\s+([a-z\s]+?)(?:\s+(?:next|this|for|including|with|and|on)\b|$)/.exec(lower);
  const fromPhrase = toMatch?.[1];
  const explicit = fromPhrase ? airportForCity(fromPhrase) : null;
  if (explicit) return explicit;
  for (const [city, code] of AIRPORTS_BY_CITY.entries()) {
    if (new RegExp(`\\b${escapeRegExp(city)}\\b`).test(lower)) return code;
  }
  return null;
}

function airportForCity(input: string | undefined): string | null {
  const normalized = normalizeText(input ?? "").replace(/\bnext.*$/, "").trim();
  if (!normalized) return null;
  for (const [city, code] of AIRPORTS_BY_CITY.entries()) {
    if (normalized.includes(city)) return code;
  }
  return null;
}

function extractDateWindow(message: string, now: Date): {
  departDate: string;
  returnDate: string;
} {
  const text = normalizeText(message);
  const start = addDays(startOfUtcDay(now), /\bnext\b/.test(text) ? 7 : 5);
  const stayDays = /\bweekend\b/.test(text) ? 2 : /\bweek\b|\bentire week\b/.test(text) ? 7 : 3;
  return {
    departDate: isoDate(start),
    returnDate: isoDate(addDays(start, stayDays)),
  };
}

function announcementForPlan(destination: string, legs: CompoundMissionLeg[]): string {
  const labels = legs.map((leg) => {
    if (leg.client_step_id === "flight_search") return "flights";
    if (leg.client_step_id === "hotel_search") return "hotels";
    if (leg.client_step_id === "restaurant_search") return "dinner";
    return "food";
  });
  return `I am splitting the ${destination} plan into ${joinHuman(labels)} searches now.`;
}

function joinHuman(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "travel";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeText(message: string): string {
  return message.toLowerCase().replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function isCompoundMissionDomain(value: unknown): value is CompoundMissionDomain {
  return (
    value === "flights" ||
    value === "hotels" ||
    value === "restaurants" ||
    value === "food"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
