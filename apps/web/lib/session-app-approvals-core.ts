import { createHash } from "node:crypto";
import type { AgentManifest } from "@lumo/agent-sdk";

export type FirstPartyConnectionProvider =
  | "duffel"
  | "booking"
  | "opentable"
  | "doordash";

const FIRST_PARTY_PROVIDER_BY_AGENT_ID = new Map<string, FirstPartyConnectionProvider>([
  ["flight", "duffel"],
  ["lumo-flights", "duffel"],
  ["hotel", "booking"],
  ["lumo-hotels", "booking"],
  ["restaurant", "opentable"],
  ["lumo-restaurants", "opentable"],
  ["food", "doordash"],
  ["lumo-food", "doordash"],
]);

const FIRST_PARTY_PROVIDER_BY_NAME = new Map<string, FirstPartyConnectionProvider>([
  ["lumo flights", "duffel"],
  ["lumo hotels", "booking"],
  ["lumo restaurants", "opentable"],
  ["lumo food", "doordash"],
]);

export const FIRST_PARTY_AGENT_IDS = Array.from(FIRST_PARTY_PROVIDER_BY_AGENT_ID.keys());

export function sessionApprovalIdempotencyKey(
  session_id: string,
  agent_id: string,
): string {
  return createHash("sha256")
    .update(session_id.trim())
    .update(":")
    .update(agent_id.trim())
    .digest("hex")
    .slice(0, 32);
}

export function isFirstPartyLumoApp(
  manifest: Pick<AgentManifest, "agent_id" | "display_name">,
): boolean {
  return firstPartyConnectionProviderForApp(manifest) !== null;
}

export function firstPartyConnectionProviderForApp(
  manifest: Pick<AgentManifest, "agent_id" | "display_name">,
): FirstPartyConnectionProvider | null {
  return (
    FIRST_PARTY_PROVIDER_BY_AGENT_ID.get(manifest.agent_id) ??
    FIRST_PARTY_PROVIDER_BY_NAME.get(manifest.display_name.trim().toLowerCase()) ??
    null
  );
}

export function firstPartyConnectionProviderForAgentId(
  agent_id: string,
): FirstPartyConnectionProvider | null {
  return FIRST_PARTY_PROVIDER_BY_AGENT_ID.get(agent_id.trim()) ?? null;
}

export function isFirstPartyAgentId(agent_id: string): boolean {
  return firstPartyConnectionProviderForAgentId(agent_id) !== null;
}
