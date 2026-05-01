import { createHash } from "node:crypto";
import type { AgentManifest } from "@lumo/agent-sdk";

const FIRST_PARTY_LUMO_AGENT_IDS = new Set([
  "flight",
  "hotel",
  "restaurant",
  "food",
  "lumo-flights",
  "lumo-hotels",
  "lumo-restaurants",
  "lumo-food",
]);

const FIRST_PARTY_LUMO_NAMES = new Set([
  "lumo flights",
  "lumo hotels",
  "lumo restaurants",
  "lumo food",
]);

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
  return (
    FIRST_PARTY_LUMO_AGENT_IDS.has(manifest.agent_id) ||
    FIRST_PARTY_LUMO_NAMES.has(manifest.display_name.trim().toLowerCase())
  );
}
