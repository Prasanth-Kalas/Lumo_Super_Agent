import type {
  CompoundLegSnapshot,
  CompoundTransactionReplaySnapshot,
} from "../saga.ts";
import {
  isLegStatusV2Status,
  type LegStatusV2Status,
} from "../sse/leg-status.ts";

export interface CompoundDispatchLeg {
  leg_id: string;
  agent_id: string;
  agent_display_name: string;
  description: string;
  status: LegStatusV2Status;
}

export interface AssistantCompoundDispatchFrameValue {
  kind: "assistant_compound_dispatch";
  compound_transaction_id: string;
  legs: CompoundDispatchLeg[];
}

export function buildAssistantCompoundDispatchFrame(
  snapshot: CompoundTransactionReplaySnapshot,
  options: { descriptionsByOrder?: Map<number, string> } = {},
): AssistantCompoundDispatchFrameValue {
  return {
    kind: "assistant_compound_dispatch",
    compound_transaction_id: snapshot.compound_transaction_id,
    legs: snapshot.legs
      .slice()
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.leg_id.localeCompare(b.leg_id);
      })
      .map((leg) => ({
        leg_id: leg.leg_id,
        agent_id: leg.agent_id,
        agent_display_name: displayNameForAgent(leg.agent_id),
        description: options.descriptionsByOrder?.get(leg.order) ?? descriptionForLeg(leg),
        status: normalizeDispatchStatus(leg.status),
      })),
  };
}

export function normalizeDispatchStatus(status: string): LegStatusV2Status {
  if (status === "rollback_in_flight") return "rollback_pending";
  if (status === "authorized" || status === "awaiting_confirmation" || status === "skipped") {
    return "pending";
  }
  return isLegStatusV2Status(status) ? status : "manual_review";
}

export function displayNameForAgent(agentId: string): string {
  if (agentId === "lumo-flights") return "Lumo Flights";
  if (agentId === "lumo-hotels") return "Lumo Hotels";
  if (agentId === "lumo-restaurants") return "Lumo Restaurants";
  if (agentId === "lumo-food") return "Lumo Food";
  return titleCase(agentId.replace(/^lumo-/, "").replace(/[-_]+/g, " "));
}

export function descriptionForLeg(leg: Pick<CompoundLegSnapshot, "agent_id" | "capability_id">): string {
  const capability = leg.capability_id.toLowerCase();
  if (leg.agent_id === "lumo-flights" || capability.includes("flight")) {
    return "Booking flight ORD → LAS";
  }
  if (leg.agent_id === "lumo-hotels" || capability.includes("hotel")) {
    return "Booking hotel near the Strip";
  }
  if (leg.agent_id === "lumo-restaurants" || capability.includes("restaurant")) {
    return "Booking dinner reservation";
  }
  if (capability.includes("ground") || capability.includes("ride")) {
    return "Booking ground transport";
  }
  return titleCase(capability.replace(/[-_]+/g, " "));
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
