import { getSupabase } from "../db.js";
import {
  createCompoundTransaction,
  loadCompoundSnapshotForUser,
} from "./persistence.ts";
import {
  buildAssistantCompoundDispatchFrame,
  type AssistantCompoundDispatchFrameValue,
} from "./dispatch-frame.ts";

interface DemoChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function maybeCreateVegasWeekendCompoundDispatch(input: {
  userId: string;
  sessionId: string;
  messages: DemoChatMessage[];
}): Promise<AssistantCompoundDispatchFrameValue | null> {
  const latestUser = input.messages.findLast((m) => m.role === "user")?.content ?? "";
  if (!/\bplan\b[\s\S]{0,80}\bvegas\b[\s\S]{0,80}\bweekend\b/i.test(latestUser)) {
    return null;
  }
  if (!input.userId || input.userId === "anon") return null;
  const db = getSupabase();
  if (!db) return null;

  const created = await createCompoundTransaction({
    db,
    userId: input.userId,
    payload: vegasWeekendCompoundPayload(input.sessionId),
  });
  const snapshot = await loadCompoundSnapshotForUser(
    db,
    created.compound_transaction_id,
    input.userId,
  );
  return snapshot ? buildAssistantCompoundDispatchFrame(snapshot) : null;
}

function vegasWeekendCompoundPayload(sessionId: string) {
  return {
    session_id: sessionId,
    idempotency_key: `demo:vegas-weekend:${sessionId}`,
    currency: "USD",
    confirmation_digest:
      "2222222222222222222222222222222222222222222222222222222222222222",
    failure_policy: "rollback",
    line_items: [
      { label: "Roundtrip flight ORD to LAS", amount_cents: 24800 },
      { label: "Two-night hotel near the Strip", amount_cents: 58000 },
      { label: "Dinner reservation deposit", amount_cents: 5000 },
    ],
    legs: [
      {
        client_leg_id: "flight",
        agent_id: "lumo-flights",
        agent_version: "1.0.0",
        provider: "duffel",
        capability_id: "book_flight",
        compensation_capability_id: "cancel_flight",
        amount_cents: 24800,
        currency: "USD",
        compensation_kind: "best-effort",
        failure_policy: "rollback",
      },
      {
        client_leg_id: "hotel",
        agent_id: "lumo-hotels",
        agent_version: "1.0.0",
        provider: "booking",
        capability_id: "book_hotel",
        compensation_capability_id: "cancel_hotel",
        amount_cents: 58000,
        currency: "USD",
        compensation_kind: "best-effort",
        failure_policy: "rollback",
      },
      {
        client_leg_id: "restaurant",
        agent_id: "lumo-restaurants",
        agent_version: "1.0.0",
        provider: "mock_merchant",
        capability_id: "book_restaurant",
        compensation_capability_id: "cancel_restaurant",
        amount_cents: 5000,
        currency: "USD",
        compensation_kind: "perfect",
        failure_policy: "rollback",
      },
    ],
    dependencies: [
      {
        dependency_client_leg_id: "flight",
        dependent_client_leg_id: "hotel",
        edge_type: "requires_destination",
        evidence: { reason: "Hotel city comes from confirmed arrival city." },
      },
      {
        dependency_client_leg_id: "hotel",
        dependent_client_leg_id: "restaurant",
        edge_type: "custom",
        evidence: { reason: "Dinner timing depends on the hotel stay window." },
      },
    ],
  };
}
