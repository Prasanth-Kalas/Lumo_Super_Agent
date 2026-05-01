import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createCompoundTransaction,
  loadCompoundSnapshotForUser,
  normalizeCompoundCreatePayload,
  stableStringify,
  type MerchantProvider,
} from "./persistence.ts";
import {
  buildAssistantCompoundDispatchFrame,
  type AssistantCompoundDispatchFrameValue,
} from "./dispatch-frame.ts";
import {
  replayCompoundTransaction,
  type CompoundLegSnapshot,
  type CompoundTransactionReplaySnapshot,
} from "../saga.ts";

export const COMPOUND_MISSION_AGENT_IDS = [
  "lumo-flights",
  "lumo-hotels",
  "lumo-restaurants",
  "lumo-food",
] as const;

export type CompoundMissionAgentId = typeof COMPOUND_MISSION_AGENT_IDS[number];

export interface CompoundMissionPlan {
  announcement: string;
  legs: Array<{
    client_leg_id: string;
    agent_id: CompoundMissionAgentId;
    description: string;
    line_items_hint: Record<string, unknown>;
  }>;
  dependencies: Array<{
    dependency_leg_id: string;
    dependent_leg_id: string;
    edge_type:
      | "requires_arrival_time"
      | "requires_destination"
      | "requires_user_confirmation"
      | "custom";
  }>;
}

export interface CompoundMissionDispatch {
  announcement: string;
  frame: AssistantCompoundDispatchFrameValue;
  graph_hash: string;
  existing: boolean;
}

interface PlannerCompletionInput {
  system: string;
  user: string;
  model: string;
}

interface PlannerOptions {
  model?: string;
  complete?: (input: PlannerCompletionInput) => Promise<string>;
}

interface AnthropicLike {
  messages: {
    create(input: {
      model: string;
      max_tokens: number;
      temperature: number;
      system: string;
      messages: Array<{ role: "user"; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

const DEFAULT_PLANNER_MODEL = "claude-sonnet-4-6";
const DEFAULT_CONFIRMATION_DIGEST =
  "3333333333333333333333333333333333333333333333333333333333333333";

export async function maybeCreateCompoundMissionDispatch(input: {
  db: SupabaseClient | null;
  userId: string;
  sessionId: string;
  userMessage: string;
  anthropic: AnthropicLike;
  model?: string;
}): Promise<CompoundMissionDispatch | null> {
  if (!input.db || !input.userId || input.userId === "anon") return null;
  const plan = await planCompoundMission(input.userMessage, {
    model: input.model,
    complete: ({ system, user, model }) =>
      completeWithAnthropic(input.anthropic, { system, user, model }),
  });
  if (!plan) return null;

  const payload = buildCompoundMissionCreatePayload(plan, input.sessionId);
  const created = await createCompoundTransaction({
    db: input.db,
    userId: input.userId,
    payload,
  });
  const snapshot = await loadCompoundSnapshotForUser(
    input.db,
    created.compound_transaction_id,
    input.userId,
  );
  if (!snapshot) return null;
  return {
    announcement: plan.announcement,
    frame: buildAssistantCompoundDispatchFrame(snapshot, {
      descriptionsByOrder: descriptionsByOrder(plan),
    }),
    graph_hash: created.graph_hash,
    existing: created.existing,
  };
}

export async function planCompoundMission(
  userMessage: string,
  options: PlannerOptions = {},
): Promise<CompoundMissionPlan | null> {
  const complete = options.complete;
  if (!complete) return null;
  const raw = await complete({
    model: options.model ?? process.env.LUMO_COMPOUND_PLANNER_MODEL ?? DEFAULT_PLANNER_MODEL,
    system: compoundPlannerSystemPrompt(),
    user: compoundPlannerUserPrompt(userMessage),
  });
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  return normalizeCompoundMissionPlan(parsed);
}

export function normalizeCompoundMissionPlan(raw: unknown): CompoundMissionPlan | null {
  if (!isRecord(raw)) return null;
  const announcement = optionalString(raw.announcement, 240);
  const rawLegs = Array.isArray(raw.legs) ? raw.legs : [];
  if (rawLegs.length < 2 || rawLegs.length > 4) return null;

  const legIds = new Set<string>();
  const legs: CompoundMissionPlan["legs"] = [];
  for (const item of rawLegs) {
    if (!isRecord(item)) return null;
    const clientLegId = normalizeClientLegId(item.client_leg_id);
    const agentId = normalizeAgentId(item.agent_id);
    const description = optionalString(item.description, 160);
    if (!clientLegId || !agentId || !description || legIds.has(clientLegId)) return null;
    legIds.add(clientLegId);
    legs.push({
      client_leg_id: clientLegId,
      agent_id: agentId,
      description,
      line_items_hint: isRecord(item.line_items_hint) ? item.line_items_hint : {},
    });
  }

  const rawDependencies = Array.isArray(raw.dependencies) ? raw.dependencies : [];
  const dependencies: CompoundMissionPlan["dependencies"] = [];
  for (const item of rawDependencies) {
    if (!isRecord(item)) return null;
    const dependency = normalizeClientLegId(item.dependency_leg_id);
    const dependent = normalizeClientLegId(item.dependent_leg_id);
    const edgeType = normalizePlannerEdgeType(item.edge_type);
    if (!dependency || !dependent || !edgeType || dependency === dependent) return null;
    if (!legIds.has(dependency) || !legIds.has(dependent)) return null;
    dependencies.push({
      dependency_leg_id: dependency,
      dependent_leg_id: dependent,
      edge_type: edgeType,
    });
  }

  const normalized = canonicalizeCompoundMissionPlan({
    announcement:
      announcement ??
      "I kicked off the trip plan. I’ll track each specialist agent as it works its part.",
    legs,
    dependencies,
  });
  const replay = replayCompoundTransaction(buildReplaySnapshotForPlan(normalized));
  if (!replay.graph_valid) return null;
  return normalized;
}

export function canonicalizeCompoundMissionPlan(
  plan: CompoundMissionPlan,
): CompoundMissionPlan {
  const legs = plan.legs
    .slice()
    .sort((a, b) => a.client_leg_id.localeCompare(b.client_leg_id));
  const allowedIds = new Set(legs.map((leg) => leg.client_leg_id));
  const dependencies = plan.dependencies
    .filter(
      (dependency) =>
        allowedIds.has(dependency.dependency_leg_id) &&
        allowedIds.has(dependency.dependent_leg_id),
    )
    .slice()
    .sort((a, b) => {
      const keyA = `${a.dependency_leg_id}:${a.dependent_leg_id}:${a.edge_type}`;
      const keyB = `${b.dependency_leg_id}:${b.dependent_leg_id}:${b.edge_type}`;
      return keyA.localeCompare(keyB);
    });
  return {
    announcement: plan.announcement.trim().slice(0, 240),
    legs,
    dependencies,
  };
}

export function compoundMissionPlanHash(plan: CompoundMissionPlan): string {
  const canonical = canonicalizeCompoundMissionPlan(plan);
  return sha256Hex(stableStringify({
    legs: canonical.legs,
    dependencies: canonical.dependencies,
  }));
}

export function buildCompoundMissionCreatePayload(
  plan: CompoundMissionPlan,
  sessionId: string,
): unknown {
  const normalized = canonicalizeCompoundMissionPlan(plan);
  const planHash = compoundMissionPlanHash(normalized);
  const payload = {
    session_id: sessionId,
    idempotency_key: `compound-mission:${sessionId}:${planHash}`,
    currency: "USD",
    confirmation_digest: DEFAULT_CONFIRMATION_DIGEST,
    failure_policy: "rollback",
    line_items: normalized.legs.map((leg) => ({
      label: leg.description,
      amount_cents: 0,
      hint: leg.line_items_hint,
    })),
    legs: normalized.legs.map((leg, index) => {
      const runtime = runtimeForAgent(leg.agent_id);
      return {
        client_leg_id: leg.client_leg_id,
        agent_id: leg.agent_id,
        agent_version: "1.0.0",
        provider: runtime.provider,
        capability_id: runtime.capability_id,
        compensation_capability_id: runtime.compensation_capability_id,
        amount_cents: 0,
        currency: "USD",
        line_items: [
          {
            label: leg.description,
            amount_cents: 0,
            hint: leg.line_items_hint,
          },
        ],
        step_order: index + 1,
        compensation_kind: runtime.compensation_kind,
        failure_policy: "rollback",
      };
    }),
    dependencies: normalized.dependencies.map((dependency) => ({
      dependency_client_leg_id: dependency.dependency_leg_id,
      dependent_client_leg_id: dependency.dependent_leg_id,
      edge_type: dependency.edge_type,
      evidence: { source: "compound_mission_planner" },
    })),
  };
  // Exercise the same canonical hash + graph validation path the API uses
  // before any caller attempts persistence.
  normalizeCompoundCreatePayload(payload);
  return payload;
}

function buildReplaySnapshotForPlan(
  plan: CompoundMissionPlan,
): CompoundTransactionReplaySnapshot {
  return {
    compound_transaction_id: `plan:${compoundMissionPlanHash(plan)}`,
    status: "authorized",
    failure_policy: "rollback",
    legs: plan.legs.map((leg, index): CompoundLegSnapshot => ({
      leg_id: leg.client_leg_id,
      transaction_id: `plan:${leg.client_leg_id}`,
      order: index + 1,
      agent_id: leg.agent_id,
      capability_id: runtimeForAgent(leg.agent_id).capability_id,
      compensation_capability_id: runtimeForAgent(leg.agent_id).compensation_capability_id,
      depends_on: plan.dependencies
        .filter((dependency) => dependency.dependent_leg_id === leg.client_leg_id)
        .map((dependency) => dependency.dependency_leg_id)
        .sort(),
      status: "pending",
      compensation_kind: runtimeForAgent(leg.agent_id).compensation_kind,
      failure_policy: "rollback",
    })),
  };
}

function descriptionsByOrder(plan: CompoundMissionPlan): Map<number, string> {
  return new Map(
    canonicalizeCompoundMissionPlan(plan).legs.map((leg, index) => [
      index + 1,
      leg.description,
    ]),
  );
}

async function completeWithAnthropic(
  anthropic: AnthropicLike,
  input: PlannerCompletionInput,
): Promise<string> {
  const response = await anthropic.messages.create({
    model: input.model,
    max_tokens: 900,
    temperature: 0,
    system: input.system,
    messages: [{ role: "user", content: input.user }],
  });
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function compoundPlannerSystemPrompt(): string {
  return [
    "You are Lumo's compound trip planner.",
    "Return JSON only matching this shape:",
    "{\"announcement\":\"short user-facing sentence\",\"legs\":[{\"client_leg_id\":\"slug\",\"agent_id\":\"lumo-flights|lumo-hotels|lumo-restaurants|lumo-food\",\"description\":\"short present-participle phrase\",\"line_items_hint\":{}}],\"dependencies\":[{\"dependency_leg_id\":\"slug\",\"dependent_leg_id\":\"slug\",\"edge_type\":\"requires_arrival_time|requires_destination|requires_user_confirmation|custom\"}]}",
    "Use only these agent_id values: lumo-flights, lumo-hotels, lumo-restaurants, lumo-food.",
    "Emit 2 to 4 legs. Do not invent unsupported agents.",
    "Use dependencies only when one leg needs another leg's output, such as hotel after flight destination or dinner after hotel timing.",
    "Use complete, stable client_leg_id slugs such as flight, hotel, restaurant, food.",
    "If the request is not a compound trip, return {\"legs\":[],\"dependencies\":[],\"announcement\":\"\"}.",
  ].join(" ");
}

function compoundPlannerUserPrompt(userMessage: string): string {
  return JSON.stringify({
    user_message: userMessage.slice(0, 1200),
    allowed_agents: COMPOUND_MISSION_AGENT_IDS,
    max_legs: 4,
  });
}

function runtimeForAgent(agentId: CompoundMissionAgentId): {
  provider: MerchantProvider;
  capability_id: string;
  compensation_capability_id: string;
  compensation_kind: "perfect" | "best-effort" | "manual";
} {
  if (agentId === "lumo-flights") {
    return {
      provider: "duffel",
      capability_id: "book_flight",
      compensation_capability_id: "cancel_flight",
      compensation_kind: "best-effort",
    };
  }
  if (agentId === "lumo-hotels") {
    return {
      provider: "booking",
      capability_id: "book_hotel",
      compensation_capability_id: "cancel_hotel",
      compensation_kind: "best-effort",
    };
  }
  if (agentId === "lumo-food") {
    return {
      provider: "mock_merchant",
      capability_id: "order_food",
      compensation_capability_id: "cancel_food_order",
      compensation_kind: "perfect",
    };
  }
  return {
    provider: "mock_merchant",
    capability_id: "book_restaurant",
    compensation_capability_id: "cancel_restaurant",
    compensation_kind: "perfect",
  };
}

function normalizeAgentId(value: unknown): CompoundMissionAgentId | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return COMPOUND_MISSION_AGENT_IDS.includes(trimmed as CompoundMissionAgentId)
    ? (trimmed as CompoundMissionAgentId)
    : null;
}

function normalizeClientLegId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return slug || null;
}

function normalizePlannerEdgeType(value: unknown): CompoundMissionPlan["dependencies"][number]["edge_type"] | null {
  if (
    value === "requires_arrival_time" ||
    value === "requires_destination" ||
    value === "requires_user_confirmation" ||
    value === "custom"
  ) {
    return value;
  }
  return null;
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
