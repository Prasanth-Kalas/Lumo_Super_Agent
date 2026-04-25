/**
 * Runtime policy gate.
 *
 * Certification gets an agent into the store. This gate decides whether a
 * concrete tool call may run right now for a concrete user.
 */

import { randomUUID } from "node:crypto";
import type { AgentManifest, ToolRoutingEntry } from "@lumo/agent-sdk";
import { getSupabase } from "./db.js";
import { getInstallForUser, touchAgentInstallLastUsed } from "./app-installs.js";

export interface RuntimePolicyDecision {
  ok: boolean;
  code?: "agent_suspended" | "app_not_installed" | "rate_limited";
  message?: string;
  detail?: Record<string, unknown>;
}

export interface RuntimePolicyInput {
  user_id: string;
  agent_id: string;
  display_name: string;
  connect_model: AgentManifest["connect"]["model"];
  tool_name: string;
  cost_tier: ToolRoutingEntry["cost_tier"];
  has_active_connection: boolean;
  system_agent?: boolean;
}

interface RuntimeOverride {
  agent_id: string;
  status: "active" | "suspended" | "revoked";
  reason: string | null;
  max_calls_per_user_per_minute: number;
  max_calls_per_user_per_day: number;
  max_money_calls_per_user_per_day: number;
}

const DEFAULT_LIMITS: RuntimeOverride = {
  agent_id: "",
  status: "active",
  reason: null,
  max_calls_per_user_per_minute: 30,
  max_calls_per_user_per_day: 1000,
  max_money_calls_per_user_per_day: 25,
};

export async function evaluateRuntimePolicy(
  input: RuntimePolicyInput,
): Promise<RuntimePolicyDecision> {
  const override = await getRuntimeOverride(input.agent_id);
  if (override.status !== "active") {
    return {
      ok: false,
      code: "agent_suspended",
      message:
        override.status === "revoked"
          ? `${input.display_name} has been removed from Lumo.`
          : `${input.display_name} is temporarily suspended.`,
      detail: { agent_id: input.agent_id, reason: override.reason },
    };
  }

  const isAnon = !input.user_id || input.user_id === "anon";
  if (!isAnon && !input.system_agent) {
    const installed = input.has_active_connection
      ? true
      : (await getInstallForUser(input.user_id, input.agent_id))?.status === "installed";
    if (!installed) {
      return {
        ok: false,
        code: "app_not_installed",
        message: `Install ${input.display_name} from the Marketplace before using it.`,
        detail: { agent_id: input.agent_id, connect_model: input.connect_model },
      };
    }
  }

  const quota = await checkQuotas(input, override);
  if (!quota.ok) return quota;

  return { ok: true };
}

export async function recordRuntimeUsage(args: {
  user_id: string;
  agent_id: string;
  tool_name: string;
  cost_tier: ToolRoutingEntry["cost_tier"];
  ok: boolean;
  error_code?: string;
  latency_ms: number;
  system_agent?: boolean;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const user_id = args.user_id && args.user_id !== "anon" ? args.user_id : null;
  const { error } = await db.from("agent_tool_usage").insert({
    id: randomUUID(),
    user_id,
    agent_id: args.agent_id,
    tool_name: args.tool_name,
    cost_tier: args.cost_tier,
    ok: args.ok,
    error_code: args.error_code ?? null,
    latency_ms: Math.max(0, Math.round(args.latency_ms)),
  });
  if (error) {
    console.warn("[runtime-policy] usage insert failed:", error.message);
  }
  if (user_id && args.ok && !args.system_agent) {
    void touchAgentInstallLastUsed(user_id, args.agent_id);
  }
}

export async function listRuntimeOverrides(): Promise<RuntimeOverride[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("agent_runtime_overrides")
    .select(
      "agent_id, status, reason, max_calls_per_user_per_minute, max_calls_per_user_per_day, max_money_calls_per_user_per_day",
    )
    .order("agent_id", { ascending: true });
  if (error) {
    console.warn("[runtime-policy] list overrides failed:", error.message);
    return [];
  }
  return (data ?? []).map(normalizeOverride);
}

export async function upsertRuntimeOverride(args: {
  agent_id: string;
  status: RuntimeOverride["status"];
  reason: string | null;
  max_calls_per_user_per_minute?: number;
  max_calls_per_user_per_day?: number;
  max_money_calls_per_user_per_day?: number;
  updated_by?: string | null;
}): Promise<RuntimeOverride | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("agent_runtime_overrides")
    .upsert(
      {
        agent_id: args.agent_id,
        status: args.status,
        reason: args.reason,
        max_calls_per_user_per_minute:
          args.max_calls_per_user_per_minute ??
          DEFAULT_LIMITS.max_calls_per_user_per_minute,
        max_calls_per_user_per_day:
          args.max_calls_per_user_per_day ?? DEFAULT_LIMITS.max_calls_per_user_per_day,
        max_money_calls_per_user_per_day:
          args.max_money_calls_per_user_per_day ??
          DEFAULT_LIMITS.max_money_calls_per_user_per_day,
        updated_by: args.updated_by ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" },
    )
    .select(
      "agent_id, status, reason, max_calls_per_user_per_minute, max_calls_per_user_per_day, max_money_calls_per_user_per_day",
    )
    .single();
  if (error) {
    console.warn("[runtime-policy] upsert override failed:", error.message);
    return null;
  }
  return normalizeOverride(data);
}

async function getRuntimeOverride(agent_id: string): Promise<RuntimeOverride> {
  const db = getSupabase();
  if (!db) return { ...DEFAULT_LIMITS, agent_id };
  const { data, error } = await db
    .from("agent_runtime_overrides")
    .select(
      "agent_id, status, reason, max_calls_per_user_per_minute, max_calls_per_user_per_day, max_money_calls_per_user_per_day",
    )
    .eq("agent_id", agent_id)
    .maybeSingle();
  if (error) {
    console.warn("[runtime-policy] read override failed:", error.message);
    return { ...DEFAULT_LIMITS, agent_id };
  }
  return data ? normalizeOverride(data) : { ...DEFAULT_LIMITS, agent_id };
}

async function checkQuotas(
  input: RuntimePolicyInput,
  limits: RuntimeOverride,
): Promise<RuntimePolicyDecision> {
  if (!input.user_id || input.user_id === "anon") return { ok: true };
  const db = getSupabase();
  if (!db) return { ok: true };

  const now = new Date();
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const today = now.toISOString().slice(0, 10);

  const [minute, day, moneyDay] = await Promise.all([
    countUsage({
      user_id: input.user_id,
      agent_id: input.agent_id,
      created_at_gte: minuteAgo,
    }),
    countUsage({
      user_id: input.user_id,
      agent_id: input.agent_id,
      created_on_utc: today,
    }),
    input.cost_tier === "money"
      ? countUsage({
          user_id: input.user_id,
          agent_id: input.agent_id,
          created_on_utc: today,
          cost_tier: "money",
        })
      : Promise.resolve(0),
  ]);

  if (minute >= limits.max_calls_per_user_per_minute) {
    return quotaDenied("minute", limits.max_calls_per_user_per_minute, minute);
  }
  if (day >= limits.max_calls_per_user_per_day) {
    return quotaDenied("day", limits.max_calls_per_user_per_day, day);
  }
  if (moneyDay >= limits.max_money_calls_per_user_per_day) {
    return quotaDenied("money_day", limits.max_money_calls_per_user_per_day, moneyDay);
  }

  return { ok: true };
}

async function countUsage(args: {
  user_id: string;
  agent_id: string;
  created_at_gte?: string;
  created_on_utc?: string;
  cost_tier?: string;
}): Promise<number> {
  const db = getSupabase();
  if (!db) return 0;
  let q = db
    .from("agent_tool_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", args.user_id)
    .eq("agent_id", args.agent_id);
  if (args.created_at_gte) q = q.gte("created_at", args.created_at_gte);
  if (args.created_on_utc) q = q.eq("created_on_utc", args.created_on_utc);
  if (args.cost_tier) q = q.eq("cost_tier", args.cost_tier);
  const { count, error } = await q;
  if (error) {
    console.warn("[runtime-policy] quota count failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

function quotaDenied(
  window: string,
  limit: number,
  current: number,
): RuntimePolicyDecision {
  return {
    ok: false,
    code: "rate_limited",
    message: "This app has hit its usage limit. Try again later.",
    detail: { window, limit, current },
  };
}

function normalizeOverride(row: unknown): RuntimeOverride {
  const r = row as Partial<RuntimeOverride>;
  return {
    agent_id: String(r.agent_id ?? ""),
    status:
      r.status === "suspended" || r.status === "revoked" ? r.status : "active",
    reason: typeof r.reason === "string" ? r.reason : null,
    max_calls_per_user_per_minute:
      positiveInt(r.max_calls_per_user_per_minute) ??
      DEFAULT_LIMITS.max_calls_per_user_per_minute,
    max_calls_per_user_per_day:
      positiveInt(r.max_calls_per_user_per_day) ??
      DEFAULT_LIMITS.max_calls_per_user_per_day,
    max_money_calls_per_user_per_day:
      positiveInt(r.max_money_calls_per_user_per_day) ??
      DEFAULT_LIMITS.max_money_calls_per_user_per_day,
  };
}

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}
