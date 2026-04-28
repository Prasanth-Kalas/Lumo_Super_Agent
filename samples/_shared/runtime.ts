import { createHash } from "node:crypto";
import type { AgentManifest } from "@lumo/agent-sdk";

export type SampleAgentStatus =
  | "succeeded"
  | "needs_confirmation"
  | "failed";

export interface SampleCostActuals {
  usd: number;
  calls: number;
}

export interface ProvenanceSource {
  type: string;
  ref: string;
  hash?: string;
}

export interface SampleAgentResult<TOutputs = Record<string, unknown>> {
  status: SampleAgentStatus;
  outputs?: TOutputs;
  confirmation_card?: SampleConfirmationCard;
  provenance_evidence: {
    sources: ProvenanceSource[];
    redaction_applied: boolean;
  };
  cost_actuals: SampleCostActuals;
}

export interface SampleConfirmationCard {
  id: string;
  title: string;
  body: string;
  side_effect_summary: string;
  reversibility: "reversible" | "compensating" | "irreversible";
  expires_at: string;
  amount_cents?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface SampleStateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface SampleBrainTools {
  lumo_recall_unified(input: {
    query: string;
    limit?: number;
  }): Promise<{
    hash: string;
    results: Array<{ text: string; score: number; source?: string }>;
  }>;
  lumo_personalize_rank<T extends Record<string, unknown>>(input: {
    items: T[];
    goal: string;
  }): Promise<{ ranked: Array<T & { rank_score: number }> }>;
  lumo_optimize_trip(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface SampleAgentContext {
  user_id: string;
  request_id: string;
  now: () => Date;
  brain: SampleBrainTools;
  connectors: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
  state: SampleStateStore;
  history(input: { window_days: number }): Promise<Array<Record<string, unknown>>>;
  confirm(card: Omit<SampleConfirmationCard, "id">): SampleAgentResult;
  logCost(entry: { agent_id: string; capability: string; usd: number }): void;
}

export type SampleCapabilityHandler = (
  inputs: Record<string, unknown>,
  ctx: SampleAgentContext,
) => Promise<SampleAgentResult> | SampleAgentResult;

export interface SampleAgent {
  manifest: AgentManifest & {
    x_lumo_sample?: SampleManifestExtension;
  };
  capabilities: Record<string, SampleCapabilityHandler>;
}

export interface SampleManifestExtension {
  trust_tier_target: "experimental" | "verified" | "official";
  runtime: "node18" | "e2b";
  requires: {
    brain_tools: string[];
    connectors: string[];
    scopes: string[];
  };
  cost_model: {
    max_cost_usd_per_invocation: number;
  };
}

export function defineSampleAgent(agent: SampleAgent): SampleAgent {
  return agent;
}

export function buildConfirmationCard(
  input: Omit<SampleConfirmationCard, "id">,
): SampleConfirmationCard {
  return {
    ...input,
    id: `card_${stableHash(input).slice(0, 16)}`,
  };
}

export function withSampleIdempotency(
  capability: string,
  handler: SampleCapabilityHandler,
  options: { ttl_minutes: number },
): SampleCapabilityHandler {
  return async (inputs, ctx) => {
    const key = `idempotency:${capability}:${stableHash({
      inputs,
      user_id: ctx.user_id,
    })}`;
    const cached = await ctx.state.get<{
      stored_at: string;
      result: SampleAgentResult;
    }>(key);
    if (cached) {
      const ageMs = ctx.now().getTime() - Date.parse(cached.stored_at);
      if (Number.isFinite(ageMs) && ageMs <= options.ttl_minutes * 60_000) {
        return {
          ...cached.result,
          outputs: {
            ...(cached.result.outputs ?? {}),
            cached: true,
          },
        };
      }
    }

    const result = await handler(inputs, ctx);
    await ctx.state.set(key, {
      stored_at: ctx.now().toISOString(),
      result,
    });
    return result;
  };
}

export class MemoryStateStore implements SampleStateStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

export function createSampleContext(
  overrides: Partial<SampleAgentContext> & {
    brain?: Partial<SampleBrainTools>;
    connectors?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
  } = {},
): SampleAgentContext & {
  costLog: Array<{ agent_id: string; capability: string; usd: number }>;
} {
  const state = overrides.state ?? new MemoryStateStore();
  const costLog: Array<{ agent_id: string; capability: string; usd: number }> = [];
  const now = overrides.now ?? (() => new Date("2026-04-28T12:00:00.000Z"));

  return {
    user_id: overrides.user_id ?? "00000000-0000-0000-0000-000000000a1e",
    request_id: overrides.request_id ?? "req_sample_001",
    now,
    brain: {
      lumo_recall_unified: async () => ({
        hash: "recall_default",
        results: [{ text: "San Francisco, CA", score: 0.92 }],
      }),
      lumo_personalize_rank: async ({ items }) => ({
        ranked: items.map((item, index) => ({
          ...item,
          rank_score: 1 - index / Math.max(items.length, 1),
        })),
      }),
      lumo_optimize_trip: async () => ({
        pickup_location: "SFO",
        return_location: "SFO",
        vehicle: "Compact EV",
        total_usd: 248,
      }),
      ...(overrides.brain ?? {}),
    },
    connectors: overrides.connectors ?? {},
    state,
    history: overrides.history ?? (async () => []),
    confirm: (card) => ({
      status: "needs_confirmation",
      confirmation_card: buildConfirmationCard(card),
      provenance_evidence: { sources: [], redaction_applied: false },
      cost_actuals: { usd: 0, calls: 0 },
    }),
    logCost: (entry) => {
      costLog.push(entry);
    },
    costLog,
  };
}

export async function invokeSampleAgent(
  agent: SampleAgent,
  capability: string,
  inputs: Record<string, unknown>,
  ctx: SampleAgentContext,
): Promise<SampleAgentResult> {
  const handler = agent.capabilities[capability];
  if (!handler) {
    throw new Error(`Unknown capability ${agent.manifest.agent_id}.${capability}`);
  }
  const result = await handler(inputs, ctx);
  ctx.logCost({
    agent_id: agent.manifest.agent_id,
    capability,
    usd: result.cost_actuals.usd,
  });
  return result;
}

export function stableHash(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function inMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function stableStringify(input: unknown): string {
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = input as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}
