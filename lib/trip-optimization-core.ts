export type TripOptimizationSource = "ml" | "fallback";
export type TripOptimizationStatus = "ok" | "fallback" | "infeasible";
export type TripOptimizationObjective = "balanced" | "fastest" | "cheapest" | "comfort";

export interface TripOptimizationStopInput {
  id: string;
  label: string;
  category: string;
  duration_minutes: number;
  earliest_start_minute?: number;
  latest_end_minute?: number;
  priority?: number;
}

export interface TripOptimizationLegInput {
  from_id: string;
  to_id: string;
  duration_minutes: number;
  cost_usd?: number;
  distance_km?: number;
}

export interface OptimizeTripRequestBody {
  objective: TripOptimizationObjective;
  stops: TripOptimizationStopInput[];
  legs: TripOptimizationLegInput[];
  start_stop_id: string;
  end_stop_id?: string;
  max_solver_seconds: number;
}

export interface OptimizedTripStop {
  id: string;
  label: string;
  category: string;
  sequence: number;
  arrival_minute: number;
  departure_minute: number;
  wait_minutes: number;
}

export interface TripOptimizationResult {
  status: TripOptimizationStatus;
  objective: TripOptimizationObjective;
  route: OptimizedTripStop[];
  dropped_stop_ids: string[];
  total_duration_minutes: number;
  total_cost_usd: number;
  total_distance_km: number;
  solver: string;
  source: TripOptimizationSource;
  latency_ms: number;
  error?: string;
}

interface OptimizeTripResponseBody {
  status?: unknown;
  objective?: unknown;
  route?: unknown;
  dropped_stop_ids?: unknown;
  total_duration_minutes?: unknown;
  total_cost_usd?: unknown;
  total_distance_km?: unknown;
  solver?: unknown;
}

export interface MissionPlanForOptimization {
  original_request: string;
  mission_title: string;
  required_agents: Array<{
    agent_id: string;
    display_name: string;
    capability: string;
    capability_label: string;
    state: string;
  }>;
  unavailable_capabilities: Array<{ capability: string; capability_label: string }>;
}

const CATEGORY_DURATION: Record<string, number> = {
  origin: 0,
  flight: 60,
  hotel: 45,
  maps: 30,
  food: 45,
  restaurant: 90,
  events: 120,
  attractions: 150,
  charging: 35,
  return: 0,
};

export async function optimizeTripCore(args: {
  user_id: string;
  input: OptimizeTripRequestBody | null;
  baseUrl: string;
  authorizationHeader: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  recordUsage: (
    ok: boolean,
    error_code: string | undefined,
    latency_ms: number,
  ) => Promise<void>;
}): Promise<TripOptimizationResult | null> {
  if (!args.input) return null;
  const started = Date.now();
  const fallback = (error?: string) =>
    optimizeTripFallback(args.input!, Date.now() - started, error);

  if (!args.baseUrl || !args.authorizationHeader) {
    return fallback("ml_optimizer_not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/optimize_trip`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: args.authorizationHeader,
        "x-lumo-user-id": args.user_id,
      },
      body: JSON.stringify(args.input),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const error_code = `http_${res.status}`;
      await args.recordUsage(false, error_code, latency_ms);
      return fallback(error_code);
    }
    const body = (await res.json()) as OptimizeTripResponseBody;
    const normalized = normalizeOptimizeTripResponse(body, latency_ms);
    if (!normalized) {
      await args.recordUsage(false, "malformed_response", latency_ms);
      return fallback("malformed_response");
    }
    await args.recordUsage(true, undefined, latency_ms);
    return normalized;
  } catch (err) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    const error_code =
      err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error";
    await args.recordUsage(false, error_code, latency_ms);
    return fallback(error_code);
  }
}

export function buildTripOptimizationInput(
  plan: MissionPlanForOptimization,
): OptimizeTripRequestBody | null {
  const tripAgents = plan.required_agents.filter((agent) =>
    [
      "flights",
      "hotels",
      "maps",
      "ground_transport",
      "food",
      "restaurants",
      "events",
      "attractions",
      "ev_charging",
    ].includes(agent.capability),
  );
  if (tripAgents.length < 2 && !mentionsTrip(plan.original_request)) return null;

  const objective = inferObjective(plan.original_request);
  const originLabel = inferOriginLabel(plan.original_request);
  const destinationLabel = inferDestinationLabel(plan);
  const stops: TripOptimizationStopInput[] = [
    {
      id: "origin",
      label: originLabel,
      category: "origin",
      duration_minutes: 0,
      earliest_start_minute: 8 * 60,
      latest_end_minute: 24 * 60,
      priority: 10,
    },
  ];

  for (const agent of tripAgents) {
    const category = categoryForCapability(agent.capability);
    if (stops.some((stop) => stop.category === category)) continue;
    stops.push({
      id: category,
      label: labelForStop(agent, destinationLabel),
      category,
      duration_minutes: CATEGORY_DURATION[category] ?? 45,
      earliest_start_minute: earliestForCategory(category),
      latest_end_minute: latestForCategory(category),
      priority: priorityForCapability(agent.capability),
    });
  }

  const hasReturn = /\b(return|back|coming back)\b/i.test(plan.original_request);
  const endId = hasReturn ? "return" : stops.some((stop) => stop.id === "hotel") ? "hotel" : "destination";
  if (!stops.some((stop) => stop.id === endId)) {
    stops.push({
      id: endId,
      label: hasReturn ? `Return to ${originLabel}` : destinationLabel,
      category: hasReturn ? "return" : "hotel",
      duration_minutes: 0,
      earliest_start_minute: 0,
      latest_end_minute: 7 * 24 * 60,
      priority: 10,
    });
  }

  return {
    objective,
    stops,
    legs: buildLegEstimates(stops),
    start_stop_id: "origin",
    end_stop_id: endId,
    max_solver_seconds: 2,
  };
}

export function optimizeTripFallback(
  input: OptimizeTripRequestBody,
  latency_ms = 0,
  error?: string,
): TripOptimizationResult {
  const start = Math.max(0, input.stops.findIndex((stop) => stop.id === input.start_stop_id));
  const end = input.end_stop_id
    ? input.stops.findIndex((stop) => stop.id === input.end_stop_id)
    : -1;
  const remaining = new Set(input.stops.map((_, index) => index));
  remaining.delete(start);
  if (end >= 0) remaining.delete(end);
  const order = [start];
  let current = start;
  while (remaining.size > 0) {
    const next = Array.from(remaining).sort((a, b) =>
      legDuration(input, current, a) - legDuration(input, current, b),
    )[0];
    if (next === undefined) break;
    order.push(next);
    remaining.delete(next);
    current = next;
  }
  if (end >= 0 && end !== start) order.push(end);
  return materializeRoute(input, order, "nearest-neighbor-fallback", "fallback", latency_ms, error);
}

function materializeRoute(
  input: OptimizeTripRequestBody,
  order: number[],
  solver: string,
  status: TripOptimizationStatus,
  latency_ms: number,
  error?: string,
): TripOptimizationResult {
  const route: OptimizedTripStop[] = [];
  let minute = 8 * 60;
  let previous: number | null = null;
  for (let sequence = 0; sequence < order.length; sequence++) {
    const index = order[sequence] ?? 0;
    const stop = input.stops[index];
    if (!stop) continue;
    if (previous !== null) minute += legDuration(input, previous, index);
    const earliest = stop.earliest_start_minute ?? 0;
    const wait = Math.max(0, earliest - minute);
    minute += wait;
    const arrival = minute;
    const departure = arrival + stop.duration_minutes;
    route.push({
      id: stop.id,
      label: stop.label,
      category: stop.category,
      sequence,
      arrival_minute: arrival,
      departure_minute: departure,
      wait_minutes: wait,
    });
    minute = departure;
    previous = index;
  }
  const totals = routeTotals(input, order);
  return {
    status,
    objective: input.objective,
    route,
    dropped_stop_ids: [],
    total_duration_minutes: totals.duration,
    total_cost_usd: roundMoney(totals.cost),
    total_distance_km: Number(totals.distance.toFixed(1)),
    solver,
    source: "fallback",
    latency_ms: Math.max(0, Math.round(latency_ms)),
    error,
  };
}

function normalizeOptimizeTripResponse(
  body: OptimizeTripResponseBody,
  latency_ms: number,
): TripOptimizationResult | null {
  const status = normalizeStatus(body.status);
  const objective = normalizeObjective(body.objective);
  if (!status || !objective || !Array.isArray(body.route)) return null;
  const route = body.route.flatMap((item, index): OptimizedTripStop[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Partial<OptimizedTripStop>;
    if (typeof raw.id !== "string" || typeof raw.label !== "string") return [];
    return [
      {
        id: raw.id,
        label: raw.label,
        category: typeof raw.category === "string" ? raw.category : "stop",
        sequence: numberOr(raw.sequence, index),
        arrival_minute: numberOr(raw.arrival_minute, 0),
        departure_minute: numberOr(raw.departure_minute, 0),
        wait_minutes: numberOr(raw.wait_minutes, 0),
      },
    ];
  });
  if (route.length < 2) return null;
  return {
    status,
    objective,
    route: route.sort((a, b) => a.sequence - b.sequence),
    dropped_stop_ids: normalizeStringArray(body.dropped_stop_ids),
    total_duration_minutes: numberOr(body.total_duration_minutes, 0),
    total_cost_usd: numberOr(body.total_cost_usd, 0),
    total_distance_km: numberOr(body.total_distance_km, 0),
    solver: typeof body.solver === "string" ? body.solver : "unknown",
    source: "ml",
    latency_ms,
  };
}

function buildLegEstimates(stops: TripOptimizationStopInput[]): TripOptimizationLegInput[] {
  const legs: TripOptimizationLegInput[] = [];
  for (const from of stops) {
    for (const to of stops) {
      if (from.id === to.id) continue;
      const duration = defaultDuration(from.category, to.category);
      legs.push({
        from_id: from.id,
        to_id: to.id,
        duration_minutes: duration,
        cost_usd: roundMoney(duration * 0.7),
        distance_km: Number((duration * 0.62).toFixed(1)),
      });
    }
  }
  return legs;
}

function routeTotals(input: OptimizeTripRequestBody, order: number[]): {
  duration: number;
  cost: number;
  distance: number;
} {
  let duration = 0;
  let cost = 0;
  let distance = 0;
  for (const index of order) {
    duration += input.stops[index]?.duration_minutes ?? 0;
  }
  for (const [from, to] of pairs(order)) {
    const leg = findLeg(input, from, to);
    duration += leg?.duration_minutes ?? legDuration(input, from, to);
    cost += leg?.cost_usd ?? 0;
    distance += leg?.distance_km ?? 0;
  }
  return { duration, cost, distance };
}

function* pairs(values: number[]): IterableIterator<[number, number]> {
  for (let i = 0; i < values.length - 1; i++) {
    yield [values[i] ?? 0, values[i + 1] ?? 0];
  }
}

function findLeg(
  input: OptimizeTripRequestBody,
  fromIndex: number,
  toIndex: number,
): TripOptimizationLegInput | null {
  const from = input.stops[fromIndex]?.id;
  const to = input.stops[toIndex]?.id;
  return input.legs.find((leg) => leg.from_id === from && leg.to_id === to) ?? null;
}

function legDuration(input: OptimizeTripRequestBody, fromIndex: number, toIndex: number): number {
  return findLeg(input, fromIndex, toIndex)?.duration_minutes ??
    defaultDuration(input.stops[fromIndex]?.category ?? "", input.stops[toIndex]?.category ?? "");
}

function defaultDuration(fromCategory: string, toCategory: string): number {
  if (fromCategory === toCategory) return 15;
  const pair = new Set([fromCategory, toCategory]);
  if (pair.has("flight")) return 90;
  if (pair.has("hotel")) return 35;
  if (pair.has("charging")) return 45;
  if (pair.has("food") || pair.has("restaurant")) return 25;
  return 30;
}

function labelForStop(
  agent: MissionPlanForOptimization["required_agents"][number],
  destination: string,
): string {
  if (agent.capability === "hotels") return `${destination} hotel base`;
  if (agent.capability === "flights") return "Flight itinerary window";
  if (agent.capability === "ev_charging") return "EV charging stop";
  if (agent.capability === "events") return `${destination} events block`;
  if (agent.capability === "attractions") return `${destination} attractions block`;
  return agent.capability_label;
}

function categoryForCapability(capability: string): string {
  if (capability === "flights") return "flight";
  if (capability === "hotels") return "hotel";
  if (capability === "ev_charging") return "charging";
  if (capability === "restaurants") return "restaurant";
  if (capability === "ground_transport") return "maps";
  return capability;
}

function priorityForCapability(capability: string): number {
  if (capability === "flights" || capability === "hotels") return 10;
  if (capability === "ev_charging" || capability === "maps") return 8;
  return 6;
}

function earliestForCategory(category: string): number {
  if (category === "food" || category === "restaurant" || category === "events") return 18 * 60;
  if (category === "attractions") return 10 * 60;
  return 8 * 60;
}

function latestForCategory(category: string): number {
  if (category === "food" || category === "restaurant") return 22 * 60;
  if (category === "events") return 23 * 60;
  if (category === "attractions") return 18 * 60;
  return 7 * 24 * 60;
}

function inferOriginLabel(request: string): string {
  const fromMatch = /\bfrom\s+([a-z][a-z\s]{2,30})(?:\s+to|\s+next|\s+for|\s+and|\s*$)/i.exec(request);
  if (fromMatch?.[1]) return titleCase(fromMatch[1].trim());
  if (/\bcalifornia\b/i.test(request)) return "California";
  return "Your starting point";
}

function inferDestinationLabel(plan: MissionPlanForOptimization): string {
  if (/\b(vegas|las vegas)\b/i.test(plan.original_request)) return "Vegas";
  const toMatch = /\bto\s+([a-z][a-z\s]{2,30})(?:\s+from|\s+for|\s+next|\s+and|\s*$)/i.exec(
    plan.original_request,
  );
  if (toMatch?.[1]) return titleCase(toMatch[1].trim());
  return plan.mission_title.replace(/^your\s+/i, "").replace(/\s+trip$/i, "") || "destination";
}

function inferObjective(request: string): TripOptimizationObjective {
  if (/\b(cheapest|budget|lowest cost|save money)\b/i.test(request)) return "cheapest";
  if (/\b(fastest|quickest|asap|shortest)\b/i.test(request)) return "fastest";
  if (/\b(comfort|comfortable|luxury|easy)\b/i.test(request)) return "comfort";
  return "balanced";
}

function mentionsTrip(request: string): boolean {
  return /\b(trip|travel|vegas|flight|hotel|itinerary)\b/i.test(request);
}

function normalizeStatus(value: unknown): TripOptimizationStatus | null {
  return value === "ok" || value === "fallback" || value === "infeasible" ? value : null;
}

function normalizeObjective(value: unknown): TripOptimizationObjective | null {
  return value === "balanced" || value === "fastest" || value === "cheapest" || value === "comfort"
    ? value
    : null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function titleCase(input: string): string {
  return input.replace(/\b[a-z]/g, (m) => m.toUpperCase());
}
