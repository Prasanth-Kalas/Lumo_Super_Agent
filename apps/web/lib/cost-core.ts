/**
 * Pure COST-1 helpers.
 *
 * Kept free of DB imports so the regression suite can exercise budget math,
 * forecast parsing, cost evidence, and rollup shaping without Supabase.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentManifest, ToolRoutingEntry } from "@lumo/agent-sdk";

export type CostLogStatus = "completed" | "aborted_budget" | "aborted_error";
export type BudgetWindow = "daily" | "monthly";
export type BudgetTier = "free" | "pro" | "enterprise";

export interface CostEvidence {
  forecast_usd?: number;
  forecast_source?: string;
  actual_source?: string;
  fallback_model_used?: string | false;
  budget_code?: string;
  budget_reason?: string;
  cap_usd?: number | null;
  remaining_daily_usd?: number | null;
  remaining_monthly_usd?: number | null;
  original_request_id?: string;
  [key: string]: unknown;
}

export interface CostModelEstimate {
  projectedCostUsd: number;
  maxCostUsdPerInvocation: number | null;
  modelUsed: string | null;
  forecastSource: string;
}

export interface ActualCostEstimate {
  promptTokens: number;
  completionTokens: number;
  brainCallsUsd: number;
  brainCallCount: number;
  modelTokensInput: number;
  modelTokensOutput: number;
  modelTokensCostUsd: number;
  connectorCalls: number;
  connectorCallsUsd: number;
  costUsdTotal: number;
  costUsdPlatform: number;
  costUsdDeveloperShare: number;
  modelUsed: string | null;
  evidence: CostEvidence;
}

export type BudgetCapCheckResult =
  | {
      ok: true;
      projectedCostUsd: number;
      capUsd: number | null;
      remainingDailyUsd: number | null;
      remainingMonthlyUsd: number | null;
      tier: BudgetTier | null;
      softCap: boolean;
      evidence: CostEvidence;
    }
  | {
      ok: false;
      reason:
        | "persistence_unavailable"
        | "per_invocation_cap_exceeded"
        | "daily_budget_exceeded"
        | "monthly_budget_exceeded";
      message: string;
      projectedCostUsd: number;
      capUsd: number | null;
      remainingDailyUsd: number | null;
      remainingMonthlyUsd: number | null;
      tier: BudgetTier | null;
      softCap: boolean;
      evidence: CostEvidence;
    };

export interface EvaluateBudgetCapInput {
  userId?: string | null;
  projectedCostUsd: number;
  manifestMaxCostUsd?: number | null;
  userGrantMaxCostUsd?: number | null;
  dailyCapUsd?: number | null;
  monthlyCapUsd?: number | null;
  dailySpendUsd?: number | null;
  monthlySpendUsd?: number | null;
  tier?: BudgetTier | null;
  softCap?: boolean;
  persistenceAvailable?: boolean;
}

export interface LedgerCostRowInput {
  requestId?: string;
  userId: string;
  agentId: string;
  agentVersion: string;
  capabilityId?: string | null;
  missionId?: string | null;
  missionStepId?: string | null;
  modelUsed?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  brainCallsUsd?: number;
  brainCallCount?: number;
  modelTokensInput?: number;
  modelTokensOutput?: number;
  modelTokensCostUsd?: number;
  connectorCalls?: number;
  connectorCallsUsd?: number;
  costUsdTotal?: number;
  costUsdPlatform?: number;
  costUsdDeveloperShare?: number;
  status?: CostLogStatus;
  evidence?: CostEvidence;
}

export interface CostRollupSourceRow {
  user_id?: unknown;
  agent_id?: unknown;
  capability_id?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  cost_usd_total?: unknown;
  cost_usd_platform?: unknown;
  cost_usd_developer_share?: unknown;
  status?: unknown;
  evidence?: unknown;
}

export interface CostRollupUpsertRow {
  user_id: string;
  window_start_at: string;
  window_end_at: string;
  invocation_count: number;
  aborted_budget_count: number;
  aborted_error_count: number;
  fallback_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_total: number;
  cost_usd_platform: number;
  cost_usd_developer_share: number;
  top_agents: Array<{
    agent_id: string;
    total_usd: number;
    invocation_count: number;
  }>;
  capability_breakdown: Record<
    string,
    { total_usd: number; invocation_count: number }
  >;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function deterministicUuid(input?: string | null): string {
  if (input && UUID_RE.test(input)) return input.toLowerCase();
  if (!input) return randomUUID();
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  const variant = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export function buildCostLogRow(input: LedgerCostRowInput): Record<string, unknown> {
  const requestId = deterministicUuid(input.requestId);
  const promptTokens = int(input.promptTokens);
  const completionTokens = int(input.completionTokens);
  const modelTokensInput = int(input.modelTokensInput ?? promptTokens);
  const modelTokensOutput = int(input.modelTokensOutput ?? completionTokens);
  const brainCallsUsd = money(input.brainCallsUsd);
  const modelTokensCostUsd = money(input.modelTokensCostUsd);
  const connectorCallsUsd = money(input.connectorCallsUsd);
  const computedTotal = money(brainCallsUsd + modelTokensCostUsd + connectorCallsUsd);
  const total = money(input.costUsdTotal ?? computedTotal);
  const developerShare = money(input.costUsdDeveloperShare);
  const platformShare = money(input.costUsdPlatform ?? Math.max(0, total - developerShare));
  const evidence: CostEvidence = {
    ...(input.evidence ?? {}),
    fallback_model_used: input.evidence?.fallback_model_used ?? false,
  };
  if (input.requestId && input.requestId !== requestId) {
    evidence.original_request_id = input.requestId;
  }

  return {
    request_id: requestId,
    user_id: input.userId,
    agent_id: input.agentId,
    agent_version: input.agentVersion,
    capability_id: input.capabilityId ?? null,
    mission_id: input.missionId ?? null,
    mission_step_id: input.missionStepId ?? null,
    model_used: input.modelUsed ?? null,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    brain_calls_usd: brainCallsUsd,
    brain_call_count: int(input.brainCallCount),
    model_tokens_input: modelTokensInput,
    model_tokens_output: modelTokensOutput,
    model_tokens_cost_usd: modelTokensCostUsd,
    connector_calls: int(input.connectorCalls),
    connector_calls_usd: connectorCallsUsd,
    cost_usd_total: Math.max(total, platformShare + developerShare),
    cost_usd_platform: platformShare,
    cost_usd_developer_share: developerShare,
    total_usd: Math.max(total, brainCallsUsd + modelTokensCostUsd + connectorCallsUsd),
    status: input.status ?? "completed",
    evidence,
  };
}

export function evaluateBudgetCap(input: EvaluateBudgetCapInput): BudgetCapCheckResult {
  const projectedCostUsd = money(input.projectedCostUsd);
  const manifestCap = nullableMoney(input.manifestMaxCostUsd);
  const grantCap = nullableMoney(input.userGrantMaxCostUsd);
  const perInvocationCap = minNullable(manifestCap, grantCap);

  if (!input.userId || input.userId === "anon" || projectedCostUsd <= 0) {
    return {
      ok: true,
      projectedCostUsd,
      capUsd: perInvocationCap,
      remainingDailyUsd: null,
      remainingMonthlyUsd: null,
      tier: input.tier ?? null,
      softCap: input.softCap === true,
      evidence: {
        forecast_usd: projectedCostUsd,
        forecast_source: projectedCostUsd <= 0 ? "zero_cost" : "anonymous_skip",
        cap_usd: perInvocationCap,
        fallback_model_used: false,
      },
    };
  }

  if (perInvocationCap !== null && projectedCostUsd > perInvocationCap) {
    return deniedBudget({
      reason: "per_invocation_cap_exceeded",
      message: "This agent call would exceed the per-invocation budget cap.",
      projectedCostUsd,
      capUsd: perInvocationCap,
      remainingDailyUsd: null,
      remainingMonthlyUsd: null,
      tier: input.tier ?? null,
      softCap: input.softCap === true,
    });
  }

  if (input.persistenceAvailable === false) {
    return {
      ok: false,
      reason: "persistence_unavailable",
      message: "Cost persistence is unavailable, so Lumo cannot safely check this budget.",
      projectedCostUsd,
      capUsd: perInvocationCap,
      remainingDailyUsd: null,
      remainingMonthlyUsd: null,
      tier: input.tier ?? null,
      softCap: input.softCap === true,
      evidence: {
        forecast_usd: projectedCostUsd,
        forecast_source: "cost_persistence_unavailable",
        budget_code: "PERSISTENCE_UNAVAILABLE",
        cap_usd: perInvocationCap,
        fallback_model_used: false,
      },
    };
  }

  const remainingDaily =
    input.dailyCapUsd === null || input.dailyCapUsd === undefined
      ? null
      : money(input.dailyCapUsd - money(input.dailySpendUsd));
  const remainingMonthly =
    input.monthlyCapUsd === null || input.monthlyCapUsd === undefined
      ? null
      : money(input.monthlyCapUsd - money(input.monthlySpendUsd));
  const effectiveCap = minNullable(perInvocationCap, remainingDaily, remainingMonthly);
  const common = {
    projectedCostUsd,
    capUsd: effectiveCap,
    remainingDailyUsd: remainingDaily,
    remainingMonthlyUsd: remainingMonthly,
    tier: input.tier ?? null,
    softCap: input.softCap === true,
  };

  if (remainingDaily !== null && projectedCostUsd > remainingDaily) {
    if (input.softCap) return allowedWithEvidence(common, "daily_soft_cap_exceeded");
    return deniedBudget({
      ...common,
      reason: "daily_budget_exceeded",
      message: "This call would exceed your daily Lumo agent budget.",
    });
  }
  if (remainingMonthly !== null && projectedCostUsd > remainingMonthly) {
    if (input.softCap) return allowedWithEvidence(common, "monthly_soft_cap_exceeded");
    return deniedBudget({
      ...common,
      reason: "monthly_budget_exceeded",
      message: "This call would exceed your monthly Lumo agent budget.",
    });
  }

  return allowedWithEvidence(common, "budget_checked");
}

export function estimateCostForRouting(
  manifest: AgentManifest,
  routing: ToolRoutingEntry,
): CostModelEstimate {
  const manifestRecord = manifest as AgentManifest & Record<string, unknown>;
  const maxCostUsdPerInvocation = firstNumberAt(manifestRecord, [
    ["cost_model", "max_cost_usd_per_invocation"],
    ["x_lumo", "cost_model", "max_cost_usd_per_invocation"],
    ["x_lumo_sample", "cost_model", "max_cost_usd_per_invocation"],
    ["pricing", "max_cost_usd_per_invocation"],
  ]);
  const declaredProjected = firstNumberAt(manifestRecord, [
    ["cost_model", "per_invocation_usd"],
    ["cost_model", "projected_cost_usd"],
    ["x_lumo", "cost_model", "per_invocation_usd"],
    ["x_lumo_sample", "cost_model", "per_invocation_usd"],
    ["pricing", "per_invocation_usd"],
  ]);
  const projectedCostUsd = money(declaredProjected ?? defaultProjectedCostForTier(routing.cost_tier));
  const modelUsed =
    stringAt(manifestRecord, ["cost_model", "model"]) ??
    stringAt(manifestRecord, ["x_lumo", "cost_model", "model"]) ??
    stringAt(manifestRecord, ["x_lumo_sample", "cost_model", "model"]);

  return {
    projectedCostUsd,
    maxCostUsdPerInvocation: nullableMoney(maxCostUsdPerInvocation),
    modelUsed,
    forecastSource: declaredProjected === null ? `cost_tier:${routing.cost_tier}` : "manifest_cost_model",
  };
}

export function extractInvocationCostActuals(
  result: unknown,
  context: {
    manifest: AgentManifest;
    routing: ToolRoutingEntry;
    forecast: CostModelEstimate;
    status?: CostLogStatus;
    budgetEvidence?: CostEvidence;
  },
): ActualCostEstimate {
  const costActuals = isRecord(result) ? findCostActuals(result) : null;
  const promptTokens = int(
    numberAt(costActuals, ["model_tokens_input"]) ??
      numberAt(costActuals, ["prompt_tokens"]) ??
      numberAt(result, ["usage", "input_tokens"]),
  );
  const completionTokens = int(
    numberAt(costActuals, ["model_tokens_output"]) ??
      numberAt(costActuals, ["completion_tokens"]) ??
      numberAt(result, ["usage", "output_tokens"]),
  );
  const modelTokensCostUsd = money(
    numberAt(costActuals, ["model_tokens_cost_usd"]) ??
      numberAt(costActuals, ["token_usd"]) ??
      (context.forecast.modelUsed
        ? estimateModelTokenCost(context.forecast.modelUsed, promptTokens, completionTokens)
        : 0),
  );
  const brainCallsUsd = money(numberAt(costActuals, ["brain_calls_usd"]) ?? 0);
  const connectorCallsUsd = money(numberAt(costActuals, ["connector_calls_usd"]) ?? 0);
  const explicitTotal = numberAt(costActuals, ["total_usd"]) ?? numberAt(costActuals, ["usd"]);
  const fallbackTotal =
    brainCallsUsd + modelTokensCostUsd + connectorCallsUsd > 0
      ? brainCallsUsd + modelTokensCostUsd + connectorCallsUsd
      : context.status === "completed"
        ? context.forecast.projectedCostUsd
        : 0;
  const total = money(explicitTotal ?? fallbackTotal);
  const developerShare = money(numberAt(costActuals, ["developer_share_usd"]) ?? 0);

  return {
    promptTokens,
    completionTokens,
    brainCallsUsd,
    brainCallCount: int(numberAt(costActuals, ["brain_call_count"]) ?? (brainCallsUsd > 0 ? 1 : 0)),
    modelTokensInput: promptTokens,
    modelTokensOutput: completionTokens,
    modelTokensCostUsd,
    connectorCalls: int(numberAt(costActuals, ["connector_calls"]) ?? (connectorCallsUsd > 0 ? 1 : 0)),
    connectorCallsUsd,
    costUsdTotal: total,
    costUsdPlatform: money(Math.max(0, total - developerShare)),
    costUsdDeveloperShare: developerShare,
    modelUsed: stringAt(costActuals, ["model_used"]) ?? context.forecast.modelUsed,
    evidence: {
      ...(context.budgetEvidence ?? {}),
      forecast_usd: context.forecast.projectedCostUsd,
      forecast_source: context.forecast.forecastSource,
      actual_source: costActuals
        ? "agent_cost_actuals"
        : context.status === "completed"
          ? "forecast_fallback"
          : "no_result",
      fallback_model_used:
        context.budgetEvidence?.fallback_model_used ??
        (stringAt(costActuals, ["fallback_model_used"]) ?? false),
    },
  };
}

export function estimateModelTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = anthropicRates(model);
  return money((Math.max(0, inputTokens) / 1_000_000) * rates.input + (Math.max(0, outputTokens) / 1_000_000) * rates.output);
}

export function chooseFallbackModel(model: string): string | null {
  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return "claude-haiku-4-6";
  if (normalized.includes("sonnet")) return "claude-haiku-4-6";
  if (normalized.includes("gpt-5") && !normalized.includes("mini")) return "gpt-5-mini";
  if (normalized.includes("gemini") && normalized.includes("pro")) return "gemini-flash";
  return null;
}

export function buildCostRollupRows(
  sourceRows: CostRollupSourceRow[],
  range: { start: Date; end: Date },
): CostRollupUpsertRow[] {
  const groups = new Map<string, RollupAccumulator>();
  for (const row of sourceRows) {
    const userId = typeof row.user_id === "string" ? row.user_id : null;
    if (!userId) continue;
    const acc = groups.get(userId) ?? emptyRollup(userId);
    acc.invocation_count++;
    if (row.status === "aborted_budget") acc.aborted_budget_count++;
    if (row.status === "aborted_error") acc.aborted_error_count++;
    if (isRecord(row.evidence) && row.evidence.fallback_model_used) acc.fallback_count++;
    acc.prompt_tokens += int(row.prompt_tokens);
    acc.completion_tokens += int(row.completion_tokens);
    acc.cost_usd_total = money(acc.cost_usd_total + money(row.cost_usd_total));
    acc.cost_usd_platform = money(acc.cost_usd_platform + money(row.cost_usd_platform));
    acc.cost_usd_developer_share = money(acc.cost_usd_developer_share + money(row.cost_usd_developer_share));
    addTopAgent(acc, String(row.agent_id ?? "unknown"), money(row.cost_usd_total));
    addCapability(acc, String(row.capability_id ?? "unknown"), money(row.cost_usd_total));
    groups.set(userId, acc);
  }

  return [...groups.values()].map((acc) => ({
    user_id: acc.user_id,
    window_start_at: range.start.toISOString(),
    window_end_at: range.end.toISOString(),
    invocation_count: acc.invocation_count,
    aborted_budget_count: acc.aborted_budget_count,
    aborted_error_count: acc.aborted_error_count,
    fallback_count: acc.fallback_count,
    prompt_tokens: acc.prompt_tokens,
    completion_tokens: acc.completion_tokens,
    cost_usd_total: acc.cost_usd_total,
    cost_usd_platform: acc.cost_usd_platform,
    cost_usd_developer_share: acc.cost_usd_developer_share,
    top_agents: topAgentsJson(acc),
    capability_breakdown: capabilityBreakdownJson(acc),
  }));
}

export function digestBody(
  digestType: "daily" | "monthly",
  spend: number,
  invocationCount: number,
  topAgents: unknown,
): string {
  const firstAgent =
    Array.isArray(topAgents) && isRecord(topAgents[0]) && typeof topAgents[0].agent_id === "string"
      ? ` Top agent: ${topAgents[0].agent_id}.`
      : "";
  return `Your ${digestType} Lumo agent spend was $${money(spend).toFixed(2)} across ${int(invocationCount)} invocation${int(invocationCount) === 1 ? "" : "s"}.${firstAgent}`;
}

export function utcDayRange(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function utcMonthRange(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

export function previousUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isoMonthStart(date: Date): string {
  return isoDate(utcMonthRange(date).start);
}

export function minNullable(...values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finite.length === 0 ? null : Math.min(...finite);
}

export function nullableMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? money(parsed) : null;
}

export function money(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

export function int(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed);
}

function deniedBudget(input: {
  reason: Extract<BudgetCapCheckResult, { ok: false }>["reason"];
  message: string;
  projectedCostUsd: number;
  capUsd: number | null;
  remainingDailyUsd: number | null;
  remainingMonthlyUsd: number | null;
  tier: BudgetTier | null;
  softCap: boolean;
}): BudgetCapCheckResult {
  return {
    ok: false,
    ...input,
    evidence: {
      forecast_usd: input.projectedCostUsd,
      forecast_source: "budget_preflight",
      budget_code: "BUDGET_EXCEEDED",
      budget_reason: input.reason,
      cap_usd: input.capUsd,
      remaining_daily_usd: input.remainingDailyUsd,
      remaining_monthly_usd: input.remainingMonthlyUsd,
      fallback_model_used: false,
    },
  };
}

function allowedWithEvidence(input: {
  projectedCostUsd: number;
  capUsd: number | null;
  remainingDailyUsd: number | null;
  remainingMonthlyUsd: number | null;
  tier: BudgetTier | null;
  softCap: boolean;
}, source: string): Extract<BudgetCapCheckResult, { ok: true }> {
  return {
    ok: true,
    ...input,
    evidence: {
      forecast_usd: input.projectedCostUsd,
      forecast_source: source,
      cap_usd: input.capUsd,
      remaining_daily_usd: input.remainingDailyUsd,
      remaining_monthly_usd: input.remainingMonthlyUsd,
      fallback_model_used: false,
    },
  };
}

function defaultProjectedCostForTier(tier: ToolRoutingEntry["cost_tier"]): number {
  if (tier === "money") return 0.05;
  if (tier === "metered") return 0.01;
  if (tier === "low") return 0.002;
  return 0;
}

function findCostActuals(result: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [
    result.cost_actuals,
    result._lumo_cost,
    result.cost,
    isRecord(result._lumo_summary) ? result._lumo_summary.cost_actuals : null,
  ];
  return candidates.find(isRecord) ?? null;
}

function anthropicRates(model: string): { input: number; output: number } {
  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return { input: 15, output: 75 };
  if (normalized.includes("sonnet")) return { input: 3, output: 15 };
  if (normalized.includes("haiku")) return { input: 0.25, output: 1.25 };
  return { input: 3, output: 15 };
}

interface RollupAccumulator {
  user_id: string;
  invocation_count: number;
  aborted_budget_count: number;
  aborted_error_count: number;
  fallback_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_total: number;
  cost_usd_platform: number;
  cost_usd_developer_share: number;
  agentTotals: Map<string, { total_usd: number; invocation_count: number }>;
  capabilityTotals: Map<string, { total_usd: number; invocation_count: number }>;
}

function emptyRollup(userId: string): RollupAccumulator {
  return {
    user_id: userId,
    invocation_count: 0,
    aborted_budget_count: 0,
    aborted_error_count: 0,
    fallback_count: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd_total: 0,
    cost_usd_platform: 0,
    cost_usd_developer_share: 0,
    agentTotals: new Map(),
    capabilityTotals: new Map(),
  };
}

function addTopAgent(acc: RollupAccumulator, agentId: string, totalUsd: number): void {
  const current = acc.agentTotals.get(agentId) ?? { total_usd: 0, invocation_count: 0 };
  current.total_usd = money(current.total_usd + totalUsd);
  current.invocation_count++;
  acc.agentTotals.set(agentId, current);
}

function addCapability(acc: RollupAccumulator, capabilityId: string, totalUsd: number): void {
  const current = acc.capabilityTotals.get(capabilityId) ?? { total_usd: 0, invocation_count: 0 };
  current.total_usd = money(current.total_usd + totalUsd);
  current.invocation_count++;
  acc.capabilityTotals.set(capabilityId, current);
}

function topAgentsJson(acc: RollupAccumulator): CostRollupUpsertRow["top_agents"] {
  return [...acc.agentTotals.entries()]
    .map(([agent_id, value]) => ({ agent_id, ...value }))
    .sort((a, b) => Number(b.total_usd) - Number(a.total_usd))
    .slice(0, 5);
}

function capabilityBreakdownJson(acc: RollupAccumulator): CostRollupUpsertRow["capability_breakdown"] {
  const out: CostRollupUpsertRow["capability_breakdown"] = {};
  for (const [capabilityId, value] of acc.capabilityTotals.entries()) {
    out[capabilityId] = value;
  }
  return out;
}

function firstNumberAt(record: Record<string, unknown>, paths: string[][]): number | null {
  for (const path of paths) {
    const value = numberAt(record, path);
    if (value !== null) return value;
  }
  return null;
}

function numberAt(value: unknown, path: string[]): number | null {
  let cursor = value;
  for (const key of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  const parsed = typeof cursor === "number" ? cursor : typeof cursor === "string" ? Number(cursor) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function stringAt(value: unknown, path: string[]): string | null {
  let cursor = value;
  for (const key of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
