/**
 * COST-1 metering and budget enforcement.
 *
 * DB-facing application boundary for migration 039. Pure math and shaping
 * live in cost-core.ts so tests can exercise them without Supabase.
 */

import { getSupabase } from "./db.js";
import { deliver } from "./notifications.js";
import {
  buildCostLogRow,
  buildCostRollupRows,
  deterministicUuid,
  digestBody,
  evaluateBudgetCap,
  estimateCostForRouting,
  extractInvocationCostActuals,
  estimateModelTokenCost,
  chooseFallbackModel,
  int,
  isoDate,
  isoMonthStart,
  money,
  nullableMoney,
  previousUtcMonth,
  utcDayRange,
  utcMonthRange,
  type ActualCostEstimate,
  type BudgetCapCheckResult,
  type BudgetTier,
  type BudgetWindow,
  type CostEvidence,
  type CostLogStatus,
  type CostModelEstimate,
  type CostRollupSourceRow,
} from "./cost-core.js";

export {
  chooseFallbackModel,
  deterministicUuid,
  digestBody,
  estimateCostForRouting,
  estimateModelTokenCost,
  evaluateBudgetCap,
  extractInvocationCostActuals,
  type ActualCostEstimate,
  type BudgetCapCheckResult,
  type BudgetTier,
  type BudgetWindow,
  type CostEvidence,
  type CostLogStatus,
  type CostModelEstimate,
};

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

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = "BudgetExceededError";
    this.detail = detail;
  }
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

  const row = buildCostLogRow(input);
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
  if (!input.userId || input.userId === "anon" || money(input.projectedCostUsd) <= 0) {
    return evaluateBudgetCap({
      userId: input.userId,
      projectedCostUsd: input.projectedCostUsd,
      manifestMaxCostUsd: input.manifestMaxCostUsd,
      userGrantMaxCostUsd: input.userGrantMaxCostUsd,
    });
  }

  const manifestCap = nullableMoney(input.manifestMaxCostUsd);
  const grantCap = nullableMoney(input.userGrantMaxCostUsd);
  const perInvocationOnly = evaluateBudgetCap({
    userId: input.userId,
    projectedCostUsd: input.projectedCostUsd,
    manifestMaxCostUsd: manifestCap,
    userGrantMaxCostUsd: grantCap,
  });
  if (!perInvocationOnly.ok) return perInvocationOnly;

  const db = getSupabase();
  if (!db) {
    return evaluateBudgetCap({
      userId: input.userId,
      projectedCostUsd: input.projectedCostUsd,
      manifestMaxCostUsd: manifestCap,
      userGrantMaxCostUsd: grantCap,
      persistenceAvailable: false,
    });
  }

  const budget = await getBudgetTier(input.userId);
  const dailySpend = await getUserCurrentSpend(input.userId, "daily");
  const monthlySpend = await getUserCurrentSpend(input.userId, "monthly");
  return evaluateBudgetCap({
    userId: input.userId,
    projectedCostUsd: input.projectedCostUsd,
    manifestMaxCostUsd: manifestCap,
    userGrantMaxCostUsd: grantCap,
    dailyCapUsd: budget.effectiveDailyCapUsd,
    monthlyCapUsd: budget.effectiveMonthlyCapUsd,
    dailySpendUsd: dailySpend.costUsdTotal,
    monthlySpendUsd: monthlySpend.costUsdTotal,
    tier: budget.tier,
    softCap: budget.softCap,
  });
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

export interface UserCostDashboard {
  budget: {
    tier: BudgetTier;
    dailyCapUsd: number | null;
    monthlyCapUsd: number | null;
    softCap: boolean;
  };
  today: SpendSummary;
  month: SpendSummary;
  daily: Array<{ date: string; totalUsd: number; invocations: number }>;
  agents: Array<{ agentId: string; totalUsd: number; invocations: number }>;
  recent: Array<{
    createdAt: string;
    agentId: string;
    capabilityId: string | null;
    totalUsd: number;
    status: CostLogStatus;
    modelUsed: string | null;
  }>;
}

export interface AdminCostDashboard {
  todayUsd: number;
  monthUsd: number;
  platformUsd: number;
  developerShareUsd: number;
  invocationCount: number;
  abortedBudgetCount: number;
  fallbackCount: number;
  dailyTrend: Array<{ date: string; totalUsd: number; invocations: number }>;
  topAgents: Array<{ agentId: string; totalUsd: number; invocations: number }>;
  topUsers: Array<{ userBucket: string; totalUsd: number; invocations: number }>;
  anomalies: Array<{ userBucket: string; todayUsd: number; monthlyUsd: number; reason: string }>;
}

export async function getUserCostDashboard(userId: string): Promise<UserCostDashboard> {
  const budget = await getBudgetTier(userId);
  const [today, month] = await Promise.all([
    getUserCurrentSpend(userId, "daily"),
    getUserCurrentSpend(userId, "monthly"),
  ]);
  const db = getSupabase();
  if (!db) {
    return {
      budget: {
        tier: budget.tier,
        dailyCapUsd: budget.effectiveDailyCapUsd,
        monthlyCapUsd: budget.effectiveMonthlyCapUsd,
        softCap: budget.softCap,
      },
      today,
      month,
      daily: [],
      agents: [],
      recent: [],
    };
  }

  const monthRange = utcMonthRange(new Date());
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: dailyRows }, { data: monthRows }, { data: recentRows }] = await Promise.all([
    db
      .from("user_cost_rollups_daily")
      .select("local_date, cost_usd_total, invocation_count")
      .eq("user_id", userId)
      .gte("local_date", isoDate(new Date(since30)))
      .order("local_date", { ascending: true }),
    db
      .from("agent_cost_log")
      .select("agent_id, cost_usd_total")
      .eq("user_id", userId)
      .gte("created_at", monthRange.start.toISOString())
      .lt("created_at", monthRange.end.toISOString())
      .limit(10_000),
    db
      .from("agent_cost_log")
      .select("created_at, agent_id, capability_id, cost_usd_total, status, model_used")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  return {
    budget: {
      tier: budget.tier,
      dailyCapUsd: budget.effectiveDailyCapUsd,
      monthlyCapUsd: budget.effectiveMonthlyCapUsd,
      softCap: budget.softCap,
    },
    today,
    month,
    daily: ((dailyRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      date: String(row.local_date ?? ""),
      totalUsd: money(row.cost_usd_total),
      invocations: int(row.invocation_count),
    })),
    agents: groupCostRowsByAgent((monthRows ?? []) as Array<Record<string, unknown>>),
    recent: ((recentRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
      createdAt: String(row.created_at ?? ""),
      agentId: String(row.agent_id ?? "unknown"),
      capabilityId: typeof row.capability_id === "string" ? row.capability_id : null,
      totalUsd: money(row.cost_usd_total),
      status: isCostStatus(row.status) ? row.status : "completed",
      modelUsed: typeof row.model_used === "string" ? row.model_used : null,
    })),
  };
}

export async function getAdminCostDashboard(): Promise<AdminCostDashboard> {
  const db = getSupabase();
  if (!db) {
    return {
      todayUsd: 0,
      monthUsd: 0,
      platformUsd: 0,
      developerShareUsd: 0,
      invocationCount: 0,
      abortedBudgetCount: 0,
      fallbackCount: 0,
      dailyTrend: [],
      topAgents: [],
      topUsers: [],
      anomalies: [],
    };
  }

  const todayRange = utcDayRange(new Date());
  const monthRange = utcMonthRange(new Date());
  const since14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const [{ data: monthRows }, { data: todayRows }, { data: trendRows }] = await Promise.all([
    db
      .from("agent_cost_log")
      .select("user_id, agent_id, cost_usd_total, cost_usd_platform, cost_usd_developer_share, status, evidence")
      .gte("created_at", monthRange.start.toISOString())
      .lt("created_at", monthRange.end.toISOString())
      .limit(50_000),
    db
      .from("agent_cost_log")
      .select("user_id, cost_usd_total")
      .gte("created_at", todayRange.start.toISOString())
      .lt("created_at", todayRange.end.toISOString())
      .limit(50_000),
    db
      .from("user_cost_rollups_daily")
      .select("local_date, cost_usd_total, invocation_count")
      .gte("local_date", isoDate(since14))
      .order("local_date", { ascending: true })
      .limit(10_000),
  ]);

  const month = (monthRows ?? []) as Array<Record<string, unknown>>;
  const today = (todayRows ?? []) as Array<Record<string, unknown>>;
  const userMonthTotals = groupRowsByUser(month);
  const userTodayTotals = groupRowsByUser(today);
  const monthUsd = money(month.reduce((sum, row) => sum + money(row.cost_usd_total), 0));
  const platformUsd = money(month.reduce((sum, row) => sum + money(row.cost_usd_platform), 0));
  const developerShareUsd = money(month.reduce((sum, row) => sum + money(row.cost_usd_developer_share), 0));

  return {
    todayUsd: money(today.reduce((sum, row) => sum + money(row.cost_usd_total), 0)),
    monthUsd,
    platformUsd,
    developerShareUsd,
    invocationCount: month.length,
    abortedBudgetCount: month.filter((row) => row.status === "aborted_budget").length,
    fallbackCount: month.filter((row) => isRecord(row.evidence) && row.evidence.fallback_model_used).length,
    dailyTrend: compactTrendRows((trendRows ?? []) as Array<Record<string, unknown>>),
    topAgents: groupCostRowsByAgent(month),
    topUsers: [...userMonthTotals.entries()]
      .map(([userId, value]) => ({
        userBucket: userBucket(userId),
        totalUsd: value.totalUsd,
        invocations: value.invocations,
      }))
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, 10),
    anomalies: [...userMonthTotals.entries()]
      .map(([userId, monthValue]) => {
        const todayValue = userTodayTotals.get(userId)?.totalUsd ?? 0;
        const monthlyDailyAverage = monthValue.totalUsd / Math.max(1, new Date().getUTCDate());
        return {
          userBucket: userBucket(userId),
          todayUsd: money(todayValue),
          monthlyUsd: money(monthValue.totalUsd),
          reason: todayValue >= Math.max(1, monthlyDailyAverage * 10) ? "10x daily average" : "",
        };
      })
      .filter((row) => row.reason)
      .slice(0, 10),
  };
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

  const rows = buildCostRollupRows((data ?? []) as CostRollupSourceRow[], input.range).map((row) => ({
    ...row,
    [input.keyColumn]: input.keyValue,
  }));
  if (rows.length === 0) {
    return { ok: true, counts: { scanned: (data ?? []).length, users: 0, upserted: 0, errors: 0 }, errors: [] };
  }

  const { error: upsertError } = await db
    .from(input.table)
    .upsert(rows, { onConflict: input.keyColumn === "local_date" ? "user_id,local_date" : "user_id,month_start" });
  if (upsertError) {
    return { ok: false, counts: { scanned: (data ?? []).length, users: rows.length, upserted: 0, errors: 1 }, errors: [upsertError.message] };
  }

  return {
    ok: true,
    counts: { scanned: (data ?? []).length, users: rows.length, upserted: rows.length, errors: 0 },
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
      effectiveDailyCapUsd: 0.5,
      effectiveMonthlyCapUsd: 5,
      softCap: false,
    };
  }
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("user_budget_tiers")
    .select("tier, daily_cap_usd, monthly_cap_usd, daily_cap_override_usd, monthly_cap_override_usd, soft_cap, effective_from, effective_until")
    .eq("user_id", userId)
    .lte("effective_from", now)
    .or(`effective_until.is.null,effective_until.gt.${now}`)
    .maybeSingle();
  if (error) {
    console.error("[cost] getBudgetTier failed:", error.message);
  }
  const row = data as Partial<BudgetTierRow> | null;
  const tier = row?.tier === "pro" || row?.tier === "enterprise" ? row.tier : "free";
  return {
    tier,
    effectiveDailyCapUsd: nullableMoney(row?.daily_cap_override_usd ?? row?.daily_cap_usd ?? 0.5),
    effectiveMonthlyCapUsd: nullableMoney(row?.monthly_cap_override_usd ?? row?.monthly_cap_usd ?? 5),
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

function groupCostRowsByAgent(rows: Array<Record<string, unknown>>): Array<{
  agentId: string;
  totalUsd: number;
  invocations: number;
}> {
  const grouped = new Map<string, { totalUsd: number; invocations: number }>();
  for (const row of rows) {
    const agentId = String(row.agent_id ?? "unknown");
    const current = grouped.get(agentId) ?? { totalUsd: 0, invocations: 0 };
    current.totalUsd = money(current.totalUsd + money(row.cost_usd_total));
    current.invocations++;
    grouped.set(agentId, current);
  }
  return [...grouped.entries()]
    .map(([agentId, value]) => ({ agentId, ...value }))
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 10);
}

function groupRowsByUser(rows: Array<Record<string, unknown>>): Map<string, {
  totalUsd: number;
  invocations: number;
}> {
  const grouped = new Map<string, { totalUsd: number; invocations: number }>();
  for (const row of rows) {
    const userId = String(row.user_id ?? "");
    if (!userId) continue;
    const current = grouped.get(userId) ?? { totalUsd: 0, invocations: 0 };
    current.totalUsd = money(current.totalUsd + money(row.cost_usd_total));
    current.invocations++;
    grouped.set(userId, current);
  }
  return grouped;
}

function compactTrendRows(rows: Array<Record<string, unknown>>): Array<{
  date: string;
  totalUsd: number;
  invocations: number;
}> {
  const byDate = new Map<string, { totalUsd: number; invocations: number }>();
  for (const row of rows) {
    const date = String(row.local_date ?? "");
    if (!date) continue;
    const current = byDate.get(date) ?? { totalUsd: 0, invocations: 0 };
    current.totalUsd = money(current.totalUsd + money(row.cost_usd_total));
    current.invocations += int(row.invocation_count);
    byDate.set(date, current);
  }
  return [...byDate.entries()].map(([date, value]) => ({ date, ...value }));
}

function userBucket(userId: string): string {
  return `user_${userId.replace(/-/g, "").slice(0, 8)}`;
}

function isCostStatus(value: unknown): value is CostLogStatus {
  return value === "completed" || value === "aborted_budget" || value === "aborted_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
