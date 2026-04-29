/**
 * COST-1 metering and budget enforcement.
 *
 * This is the application boundary for migration 039. It intentionally keeps
 * cost evidence structured and boring so dashboards, cron digests, and future
 * billing reconciliation can all read the same payload without shape guessing.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentManifest, ToolRoutingEntry } from "@lumo/agent-sdk";
import { getSupabase } from "./db.js";
import { deliver } from "./notifications.js";

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

export interface InvocationCostInput {
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

export interface SpendSummary {
  window: BudgetWindow;
  windowStartAt: Date;
  windowEndAt: Date;
  costUsdTotal: number;
  source: "rollup_plus_delta" | "ledger" | "none";
}

export interface BudgetTierRow {
  user_id: string;
  tier: BudgetTier;
  daily_cap_usd: number | string;
  monthly_cap_usd: number | string;
  daily_cap_override_usd: number | string | null;
  monthly_cap_override_usd: number | string | null;
  soft_cap: boolean;
  effective_from: string;
  effective_until: string | null;
}

export interface BudgetCapCheckInput {
  userId: string;
  agentId: string;
  projectedCostUsd: number;
  manifestMaxCostUsd?: number | null;
  userGrantMaxCostUsd?: number | null;
  requestId?: string;
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

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = "BudgetExceededError";
    this.detail = detail;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_TIER_DAILY_CAP_USD = 0.5;
const DEFAULT_TIER_MONTHLY_CAP_USD = 5;

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

export async function recordInvocationCost(input: InvocationCostInput): Promise<{
  ok: boolean;
  requestId: string;
  error?: string;
}> {
  if (!input.userId || input.userId === "anon") {
    return { ok: true, requestId: deterministicUuid(input.requestId), error: "anonymous_skipped" };
  }

  const db = getSupabase();
  const requestId = deterministicUuid(input.requestId);
  if (!db) return { ok: false, requestId, error: "cost_persistence_unavailable" };

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

  const row = {
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

  const { error } = await db.from("agent_cost_log").upsert(row, { onConflict: "request_id" });
  if (error) {
    console.error("[cost] recordInvocationCost failed:", error.message);
    return { ok: false, requestId, error: error.message };
  }
  return { ok: true, requestId };
}

export async function getUserCurrentSpend(
  userId: string,
  window: BudgetWindow,
  now = new Date(),
): Promise<SpendSummary> {
  const range = window === "daily" ? utcDayRange(now) : utcMonthRange(now);
  const db = getSupabase();
  if (!db || !userId || userId === "anon") {
    return {
      window,
      windowStartAt: range.start,
      windowEndAt: range.end,
      costUsdTotal: 0,
      source: "none",
    };
  }

  const rollupTable =
    window === "daily" ? "user_cost_rollups_daily" : "user_cost_rollups_monthly";
  const dateColumn = window === "daily" ? "local_date" : "month_start";
  const dateValue = window === "daily" ? isoDate(range.start) : isoMonthStart(range.start);
  const { data: rollup } = await db
    .from(rollupTable)
    .select("cost_usd_total, window_end_at")
    .eq("user_id", userId)
    .eq(dateColumn, dateValue)
    .maybeSingle();

  const base = isRecord(rollup) ? money(rollup.cost_usd_total) : 0;
  const deltaStart =
    isRecord(rollup) && typeof rollup.window_end_at === "string"
      ? new Date(Math.max(Date.parse(rollup.window_end_at), range.start.getTime()))
      : range.start;
  const delta = await sumLedgerSpend(userId, deltaStart, range.end);

  return {
    window,
    windowStartAt: range.start,
    windowEndAt: range.end,
    costUsdTotal: money(base + delta),
    source: rollup ? "rollup_plus_delta" : "ledger",
  };
}

export async function checkBudgetCap(
  input: BudgetCapCheckInput,
): Promise<BudgetCapCheckResult> {
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
      tier: null,
      softCap: false,
      evidence: {
        forecast_usd: projectedCostUsd,
        forecast_source: projectedCostUsd <= 0 ? "zero_cost" : "anonymous_skip",
        cap_usd: perInvocationCap,
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
      tier: null,
      softCap: false,
    });
  }

  const db = getSupabase();
  if (!db) {
    return {
      ok: false,
      reason: "persistence_unavailable",
      message: "Cost persistence is unavailable, so Lumo cannot safely check this budget.",
      projectedCostUsd,
      capUsd: perInvocationCap,
      remainingDailyUsd: null,
      remainingMonthlyUsd: null,
      tier: null,
      softCap: false,
      evidence: {
        forecast_usd: projectedCostUsd,
        forecast_source: "cost_persistence_unavailable",
        budget_code: "PERSISTENCE_UNAVAILABLE",
        cap_usd: perInvocationCap,
      },
    };
  }

  const budget = await getBudgetTier(input.userId);
  const dailySpend = await getUserCurrentSpend(input.userId, "daily");
  const monthlySpend = await getUserCurrentSpend(input.userId, "monthly");
  const dailyCap = budget.effectiveDailyCapUsd;
  const monthlyCap = budget.effectiveMonthlyCapUsd;
  const remainingDaily = dailyCap === null ? null : money(dailyCap - dailySpend.costUsdTotal);
  const remainingMonthly = monthlyCap === null ? null : money(monthlyCap - monthlySpend.costUsdTotal);
  const effectiveCap = minNullable(perInvocationCap, remainingDaily, remainingMonthly);
  const common = {
    projectedCostUsd,
    capUsd: effectiveCap,
    remainingDailyUsd: remainingDaily,
    remainingMonthlyUsd: remainingMonthly,
    tier: budget.tier,
    softCap: budget.softCap,
  };

  if (remainingDaily !== null && projectedCostUsd > remainingDaily) {
    if (budget.softCap) {
      return allowedWithEvidence(common, "daily_soft_cap_exceeded");
    }
    return deniedBudget({
      ...common,
      reason: "daily_budget_exceeded",
      message: "This call would exceed your daily Lumo agent budget.",
    });
  }
  if (remainingMonthly !== null && projectedCostUsd > remainingMonthly) {
    if (budget.softCap) {
      return allowedWithEvidence(common, "monthly_soft_cap_exceeded");
    }
    return deniedBudget({
      ...common,
      reason: "monthly_budget_exceeded",
      message: "This call would exceed your monthly Lumo agent budget.",
    });
  }

  return allowedWithEvidence(common, "budget_checked");
}

export async function enforceCap(input: BudgetCapCheckInput): Promise<BudgetCapCheckResult> {
  const result = await checkBudgetCap(input);
  if (!result.ok) {
    throw new BudgetExceededError(result.message, {
      ...result.evidence,
      reason: result.reason,
      agent_id: input.agentId,
    });
  }
  return result;
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

export async function applyDailyRollup(
  args: { date?: Date; limit?: number } = {},
): Promise<RollupApplyResult> {
  const date = args.date ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const range = utcDayRange(date);
  return applyRollup({
    table: "user_cost_rollups_daily",
    keyColumn: "local_date",
    keyValue: isoDate(range.start),
    range,
    limit: args.limit,
  });
}

export async function applyMonthlyRollup(
  args: { monthStart?: Date; limit?: number } = {},
): Promise<RollupApplyResult> {
  const date = args.monthStart ?? new Date();
  const range = utcMonthRange(date);
  return applyRollup({
    table: "user_cost_rollups_monthly",
    keyColumn: "month_start",
    keyValue: isoMonthStart(range.start),
    range,
    limit: args.limit,
  });
}

export interface RollupApplyResult {
  ok: boolean;
  counts: {
    scanned: number;
    users: number;
    upserted: number;
    errors: number;
  };
  errors: string[];
}

export interface CostDigestResult {
  ok: boolean;
  counts: {
    rollup_users: number;
    candidates: number;
    sent: number;
    skipped: number;
    errors: number;
  };
  errors: string[];
}

export async function runDailyCostDigest(
  args: { date?: Date; limit?: number } = {},
): Promise<CostDigestResult> {
  const date = args.date ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rollup = await applyDailyRollup({ date, limit: args.limit });
  const periodStart = isoDate(utcDayRange(date).start);
  const periodEnd = periodStart;
  return runDigest({
    digestType: "daily",
    rollupTable: "user_cost_rollups_daily",
    dateColumn: "local_date",
    periodStart,
    periodEnd,
    spendThresholdUsd: 0.01,
    title: "Daily Lumo agent spend",
    rollup,
    limit: args.limit,
  });
}

export async function runMonthlyCostDigest(
  args: { monthStart?: Date; limit?: number } = {},
): Promise<CostDigestResult> {
  const date = args.monthStart ?? previousUtcMonth(new Date());
  const range = utcMonthRange(date);
  const rollup = await applyMonthlyRollup({ monthStart: range.start, limit: args.limit });
  return runDigest({
    digestType: "monthly",
    rollupTable: "user_cost_rollups_monthly",
    dateColumn: "month_start",
    periodStart: isoMonthStart(range.start),
    periodEnd: isoDate(new Date(range.end.getTime() - 24 * 60 * 60 * 1000)),
    spendThresholdUsd: 0,
    title: "Monthly Lumo agent spend",
    rollup,
    limit: args.limit,
  });
}

async function applyRollup(input: {
  table: "user_cost_rollups_daily" | "user_cost_rollups_monthly";
  keyColumn: "local_date" | "month_start";
  keyValue: string;
  range: { start: Date; end: Date };
  limit?: number;
}): Promise<RollupApplyResult> {
  const db = getSupabase();
  if (!db) {
    return { ok: false, counts: { scanned: 0, users: 0, upserted: 0, errors: 1 }, errors: ["cost_persistence_unavailable"] };
  }

  const { data, error } = await db
    .from("agent_cost_log")
    .select("user_id, agent_id, capability_id, prompt_tokens, completion_tokens, cost_usd_total, cost_usd_platform, cost_usd_developer_share, status, evidence")
    .gte("created_at", input.range.start.toISOString())
    .lt("created_at", input.range.end.toISOString())
    .limit(Math.max(1, Math.min(100_000, Math.trunc(input.limit ?? 50_000))));

  if (error) {
    return { ok: false, counts: { scanned: 0, users: 0, upserted: 0, errors: 1 }, errors: [error.message] };
  }

  const groups = new Map<string, RollupAccumulator>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
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

  if (groups.size === 0) {
    return { ok: true, counts: { scanned: (data ?? []).length, users: 0, upserted: 0, errors: 0 }, errors: [] };
  }

  const rows = [...groups.values()].map((acc) => ({
    user_id: acc.user_id,
    [input.keyColumn]: input.keyValue,
    window_start_at: input.range.start.toISOString(),
    window_end_at: input.range.end.toISOString(),
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

  const { error: upsertError } = await db
    .from(input.table)
    .upsert(rows, { onConflict: input.keyColumn === "local_date" ? "user_id,local_date" : "user_id,month_start" });
  if (upsertError) {
    return { ok: false, counts: { scanned: (data ?? []).length, users: groups.size, upserted: 0, errors: 1 }, errors: [upsertError.message] };
  }

  return {
    ok: true,
    counts: { scanned: (data ?? []).length, users: groups.size, upserted: rows.length, errors: 0 },
    errors: [],
  };
}

async function runDigest(input: {
  digestType: "daily" | "monthly";
  rollupTable: "user_cost_rollups_daily" | "user_cost_rollups_monthly";
  dateColumn: "local_date" | "month_start";
  periodStart: string;
  periodEnd: string;
  spendThresholdUsd: number;
  title: string;
  rollup: RollupApplyResult;
  limit?: number;
}): Promise<CostDigestResult> {
  const db = getSupabase();
  if (!db) {
    return {
      ok: false,
      counts: { rollup_users: input.rollup.counts.users, candidates: 0, sent: 0, skipped: 0, errors: 1 },
      errors: ["cost_persistence_unavailable"],
    };
  }

  const { data, error } = await db
    .from(input.rollupTable)
    .select("user_id, cost_usd_total, invocation_count, top_agents, capability_breakdown")
    .eq(input.dateColumn, input.periodStart)
    .gt("cost_usd_total", input.spendThresholdUsd)
    .limit(Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 1_000))));
  if (error) {
    return {
      ok: false,
      counts: { rollup_users: input.rollup.counts.users, candidates: 0, sent: 0, skipped: 0, errors: 1 },
      errors: [error.message],
    };
  }

  const counts = { rollup_users: input.rollup.counts.users, candidates: 0, sent: 0, skipped: 0, errors: 0 };
  const errors: string[] = [];

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    counts.candidates++;
    const userId = String(row.user_id ?? "");
    if (!userId) continue;
    try {
      const existing = await findDigestDelivery(userId, input.digestType, input.periodStart);
      if (existing === "sent") {
        counts.skipped++;
        continue;
      }
      const spend = money(row.cost_usd_total);
      await upsertDigestDelivery({
        userId,
        digestType: input.digestType,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        spendUsd: spend,
        deliveryState: "pending",
      });
      await deliver({
        user_id: userId,
        kind: "info",
        title: input.title,
        body: digestBody(input.digestType, spend, int(row.invocation_count), row.top_agents),
        payload: {
          digest_type: input.digestType,
          period_start: input.periodStart,
          period_end: input.periodEnd,
          spend_usd: spend,
          top_agents: row.top_agents ?? [],
          capability_breakdown: row.capability_breakdown ?? {},
          delivery_mode: "notification_v1",
        },
        dedup_key: `cost:${input.digestType}:${input.periodStart}`,
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      });
      await upsertDigestDelivery({
        userId,
        digestType: input.digestType,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        spendUsd: spend,
        deliveryState: "sent",
      });
      counts.sent++;
    } catch (err) {
      counts.errors++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      await upsertDigestDelivery({
        userId,
        digestType: input.digestType,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        spendUsd: money(row.cost_usd_total),
        deliveryState: "failed",
        errorText: message,
      }).catch(() => undefined);
    }
  }

  return { ok: counts.errors === 0, counts, errors: errors.slice(0, 10) };
}

async function findDigestDelivery(
  userId: string,
  digestType: "daily" | "monthly",
  periodStart: string,
): Promise<"sent" | "pending" | "failed" | "skipped" | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db
    .from("user_cost_digest_deliveries")
    .select("delivery_state")
    .eq("user_id", userId)
    .eq("digest_type", digestType)
    .eq("period_start", periodStart)
    .maybeSingle();
  const state = isRecord(data) ? data.delivery_state : null;
  return state === "sent" || state === "pending" || state === "failed" || state === "skipped"
    ? state
    : null;
}

async function upsertDigestDelivery(input: {
  userId: string;
  digestType: "daily" | "monthly";
  periodStart: string;
  periodEnd: string;
  spendUsd: number;
  deliveryState: "pending" | "sent" | "skipped" | "failed";
  errorText?: string | null;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from("user_cost_digest_deliveries").upsert(
    {
      user_id: input.userId,
      digest_type: input.digestType,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      spend_usd: input.spendUsd,
      delivery_state: input.deliveryState,
      notification_id: null,
      error_text: input.errorText ?? null,
      sent_at: input.deliveryState === "sent" ? new Date().toISOString() : null,
    },
    { onConflict: "user_id,digest_type,period_start" },
  );
  if (error) throw new Error(error.message);
}

async function getBudgetTier(userId: string): Promise<{
  tier: BudgetTier;
  effectiveDailyCapUsd: number | null;
  effectiveMonthlyCapUsd: number | null;
  softCap: boolean;
}> {
  const db = getSupabase();
  if (!db) {
    return {
      tier: "free",
      effectiveDailyCapUsd: DEFAULT_TIER_DAILY_CAP_USD,
      effectiveMonthlyCapUsd: DEFAULT_TIER_MONTHLY_CAP_USD,
      softCap: false,
    };
  }
  const { data, error } = await db
    .from("user_budget_tiers")
    .select("tier, daily_cap_usd, monthly_cap_usd, daily_cap_override_usd, monthly_cap_override_usd, soft_cap, effective_from, effective_until")
    .eq("user_id", userId)
    .lte("effective_from", new Date().toISOString())
    .or(`effective_until.is.null,effective_until.gt.${new Date().toISOString()}`)
    .maybeSingle();
  if (error) {
    console.error("[cost] getBudgetTier failed:", error.message);
  }
  const row = data as Partial<BudgetTierRow> | null;
  const tier = row?.tier === "pro" || row?.tier === "enterprise" ? row.tier : "free";
  return {
    tier,
    effectiveDailyCapUsd: nullableMoney(row?.daily_cap_override_usd ?? row?.daily_cap_usd ?? DEFAULT_TIER_DAILY_CAP_USD),
    effectiveMonthlyCapUsd: nullableMoney(row?.monthly_cap_override_usd ?? row?.monthly_cap_usd ?? DEFAULT_TIER_MONTHLY_CAP_USD),
    softCap: row?.soft_cap === true,
  };
}

async function sumLedgerSpend(userId: string, start: Date, end: Date): Promise<number> {
  const db = getSupabase();
  if (!db) return 0;
  const { data, error } = await db
    .from("agent_cost_log")
    .select("cost_usd_total")
    .eq("user_id", userId)
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString())
    .limit(10_000);
  if (error) {
    console.error("[cost] sumLedgerSpend failed:", error.message);
    return 0;
  }
  return money(
    ((data ?? []) as Array<Record<string, unknown>>).reduce(
      (sum, row) => sum + money(row.cost_usd_total),
      0,
    ),
  );
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

function topAgentsJson(acc: RollupAccumulator): Array<Record<string, unknown>> {
  return [...acc.agentTotals.entries()]
    .map(([agent_id, value]) => ({ agent_id, ...value }))
    .sort((a, b) => Number(b.total_usd) - Number(a.total_usd))
    .slice(0, 5);
}

function capabilityBreakdownJson(acc: RollupAccumulator): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [capabilityId, value] of acc.capabilityTotals.entries()) {
    out[capabilityId] = value;
  }
  return out;
}

function digestBody(
  digestType: "daily" | "monthly",
  spend: number,
  invocationCount: number,
  topAgents: unknown,
): string {
  const firstAgent =
    Array.isArray(topAgents) && isRecord(topAgents[0]) && typeof topAgents[0].agent_id === "string"
      ? ` Top agent: ${topAgents[0].agent_id}.`
      : "";
  return `Your ${digestType} Lumo agent spend was $${spend.toFixed(2)} across ${invocationCount} invocation${invocationCount === 1 ? "" : "s"}.${firstAgent}`;
}

function utcDayRange(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function utcMonthRange(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

function previousUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoMonthStart(date: Date): string {
  return isoDate(utcMonthRange(date).start);
}

function minNullable(...values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finite.length === 0 ? null : Math.min(...finite);
}

function nullableMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? money(parsed) : null;
}

function money(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

function int(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed);
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
