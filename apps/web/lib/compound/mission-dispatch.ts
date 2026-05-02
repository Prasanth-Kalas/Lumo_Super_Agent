import type { DispatchContext } from "../router.ts";
import type { ClaimedMissionStep, MissionDispatchResult } from "../mission-executor-core.ts";

export interface MissionDispatchContextInput {
  user_id: string;
  session_id: string;
  turn_id: string;
  idempotency_key: string;
  region: string;
  device_kind: "web" | "ios" | "android" | "watch";
  user_pii?: Record<string, unknown>;
}

const MISSION_TOOL_TO_DISPATCH_TOOL = new Map<string, string>([
  ["mission.flight_search", "duffel_search_flights"],
  ["mission.flights", "duffel_search_flights"],
  ["mission.hotel_search", "hotel_search"],
  ["mission.hotels", "hotel_search"],
  ["mission.restaurant_search", "restaurant_check_availability"],
  ["mission.restaurants", "restaurant_check_availability"],
  ["mission.food_search", "food_search"],
  ["mission.food", "food_search"],
]);

export function missionStepToDispatchTool(
  step: Pick<ClaimedMissionStep, "tool_name" | "inputs">,
): string | null {
  const explicit =
    typeof step.inputs.dispatch_tool_name === "string"
      ? step.inputs.dispatch_tool_name.trim()
      : "";
  if (explicit) return explicit;
  if (step.tool_name === "mission.compose_reply") return "mission.compose_reply";
  return MISSION_TOOL_TO_DISPATCH_TOOL.get(step.tool_name) ?? null;
}

export async function dispatchMissionStepToTool(
  step: ClaimedMissionStep,
  context: DispatchContext = missionDispatchContextForStep(step),
): Promise<MissionDispatchResult> {
  const started = Date.now();
  const dispatchTool = missionStepToDispatchTool(step);
  if (!dispatchTool) {
    return {
      ok: false,
      latency_ms: Date.now() - started,
      error: {
        code: "not_available",
        message: `Unsupported mission step tool: ${step.tool_name}`,
        detail: { tool_name: step.tool_name },
      },
    };
  }

  if (dispatchTool === "mission.compose_reply") {
    return {
      ok: true,
      latency_ms: Date.now() - started,
      result: {
        status: "composed",
        source: "orchestrator_compound_dispatch",
      },
    };
  }

  const [{ ensureRegistry }, { dispatchToolCall }] = await Promise.all([
    import("../agent-registry.ts"),
    import("../router.ts"),
  ]);
  const registry = await ensureRegistry();
  if (registry.bridge.routing[dispatchTool]) {
    return dispatchToolCall(dispatchTool, dispatchArgsForMissionStep(step), context);
  }

  const preview = previewResultForUnavailableTool(dispatchTool, step);
  if (preview) {
    void import("../cost.ts")
      .then(({ recordInvocationCost }) =>
        recordInvocationCost({
          requestId: `${context.idempotency_key}:preview:${dispatchTool}`,
          userId: context.user_id,
          agentId: step.agent_id,
          agentVersion: "preview",
          capabilityId: dispatchTool,
          status: "completed",
          costUsdTotal: 0,
          evidence: {
            actual_source: "compound_preview_stub",
            dispatch_tool_name: dispatchTool,
          },
        }),
      )
      .catch(() => undefined);
    return {
      ok: true,
      latency_ms: Date.now() - started,
      result: preview,
    };
  }

  return {
    ok: false,
    latency_ms: Date.now() - started,
    error: {
      code: "not_available",
      message: `No registered dispatch tool for ${dispatchTool}`,
      detail: { dispatch_tool_name: dispatchTool, mission_tool_name: step.tool_name },
    },
  };
}

export function missionDispatchContextForStep(step: ClaimedMissionStep): DispatchContext {
  return {
    user_id: step.user_id,
    session_id: `mission:${step.mission_id}`,
    turn_id: `mission-step:${step.id}`,
    idempotency_key: `mission:${step.mission_id}:${step.id}`,
    region: "US",
    device_kind: "web",
    prior_summary: null,
    user_confirmed: true,
    user_pii: {},
  };
}

export function dispatchArgsForMissionStep(
  step: Pick<ClaimedMissionStep, "inputs">,
): Record<string, unknown> {
  const raw =
    isRecord(step.inputs.line_items_hint)
      ? step.inputs.line_items_hint
      : isRecord(step.inputs.dispatch_args)
        ? step.inputs.dispatch_args
        : step.inputs;
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

export function summarizeMissionStepOutput(
  step: Pick<ClaimedMissionStep, "tool_name" | "inputs">,
  result: unknown,
): string {
  const dispatchTool = missionStepToDispatchTool(step) ?? step.tool_name;
  if (dispatchTool === "duffel_search_flights") {
    const count = Array.isArray(result)
      ? result.length
      : Array.isArray((result as { offers?: unknown[] } | null)?.offers)
        ? (result as { offers: unknown[] }).offers.length
        : 0;
    return count > 0 ? `Found ${count} flight offers.` : "Flight search returned no offers.";
  }
  if (dispatchTool === "hotel_search") {
    const hotels = isRecord(result) && Array.isArray(result.hotels) ? result.hotels.length : 0;
    return hotels > 0 ? `Found ${hotels} hotel options.` : "Hotel search is in preview mode.";
  }
  if (dispatchTool === "restaurant_check_availability") {
    const slots = isRecord(result) && Array.isArray(result.slots) ? result.slots.length : 0;
    return slots > 0 ? `Found ${slots} dinner times.` : "Restaurant availability is in preview mode.";
  }
  if (dispatchTool === "food_search" || dispatchTool === "food_get_restaurant_menu") {
    return "Found food options.";
  }
  if (dispatchTool === "mission.compose_reply") {
    return "Composed mission reply.";
  }
  return "Mission step completed.";
}

function previewResultForUnavailableTool(
  dispatchTool: string,
  step: Pick<ClaimedMissionStep, "inputs" | "agent_id">,
): Record<string, unknown> | null {
  const args = dispatchArgsForMissionStep(step);
  if (dispatchTool === "hotel_search") {
    return {
      status: "preview_stub",
      provider: "lumo-hotels-preview",
      destination: args.destination ?? "destination",
      hotels: [
        {
          id: "preview-hotel-strip",
          name: "Preview Strip Hotel",
          neighborhood: "Central",
          nightly_rate_usd: 189,
        },
        {
          id: "preview-hotel-quiet",
          name: "Preview Quiet Stay",
          neighborhood: "West side",
          nightly_rate_usd: 161,
        },
      ],
    };
  }
  if (dispatchTool === "restaurant_check_availability") {
    return {
      status: "preview_stub",
      provider: "lumo-restaurants-preview",
      destination: args.destination ?? "destination",
      slots: [
        { id: "preview-dinner-1900", starts_at: `${args.date ?? "selected-date"}T19:00:00`, party_size: args.party_size ?? 1 },
        { id: "preview-dinner-2030", starts_at: `${args.date ?? "selected-date"}T20:30:00`, party_size: args.party_size ?? 1 },
      ],
    };
  }
  if (dispatchTool === "food_search") {
    return {
      status: "preview_stub",
      provider: "lumo-food-preview",
      destination: args.destination ?? "destination",
      restaurants: [
        { id: "preview-food-1", name: "Preview Local Kitchen", eta_minutes: 32 },
      ],
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
