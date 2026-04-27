import type { ToolRoutingEntry } from "@lumo/agent-sdk";
import { createBrainSdkFetch } from "./brain-sdk/index.js";
import { recordRuntimeUsage } from "./runtime-policy.js";
import { signLumoServiceJwt } from "./service-jwt.js";
import {
  buildTripOptimizationInput,
  optimizeTripCore,
  type MissionPlanForOptimization,
  type TripOptimizationResult,
} from "./trip-optimization-core.js";

const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_OPTIMIZE_TOOL = "lumo_optimize_trip";
const TRIP_OPTIMIZATION_TIMEOUT_MS = 700;

export type { TripOptimizationResult };

export async function optimizeMissionTrip(args: {
  user_id: string;
  plan: MissionPlanForOptimization;
  fetchImpl?: typeof fetch;
  mlBaseUrl?: string;
  timeoutMs?: number;
  recordUsage?: boolean;
}): Promise<TripOptimizationResult | null> {
  const input = buildTripOptimizationInput(args.plan);
  if (!input) return null;
  const baseUrl = resolveMlBaseUrl(args.mlBaseUrl);
  const authorizationHeader = serviceAuthorizationHeader({
    baseUrl,
    user_id: args.user_id,
    scope: LUMO_OPTIMIZE_TOOL,
  });
  const timeoutMs = clampInt(args.timeoutMs, 50, 5000, TRIP_OPTIMIZATION_TIMEOUT_MS);
  return optimizeTripCore({
    user_id: args.user_id,
    input,
    baseUrl,
    authorizationHeader,
    fetchImpl:
      args.fetchImpl ??
      createBrainSdkFetch({
        user_id: args.user_id,
        baseUrl,
        timeoutMs,
        callerSurface: "trip-optimization",
      }),
    timeoutMs,
    recordUsage: (ok, error_code, latency_ms) =>
      recordOptimizationUsage({
        user_id: args.user_id,
        ok,
        error_code,
        latency_ms,
        enabled: args.recordUsage,
      }),
  });
}

function resolveMlBaseUrl(override: string | undefined): string {
  return (
    override ??
    process.env.LUMO_ML_AGENT_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:3010" : "")
  ).replace(/\/+$/, "");
}

function serviceAuthorizationHeader(args: {
  baseUrl: string;
  user_id: string;
  scope: string;
}): string | null {
  if (!args.baseUrl || !process.env.LUMO_ML_SERVICE_JWT_SECRET) return null;
  if (!args.user_id || args.user_id === "anon") return null;
  return `Bearer ${signLumoServiceJwt({
    audience: LUMO_ML_AGENT_ID,
    user_id: args.user_id,
    scope: args.scope,
    ttl_seconds: 60,
  })}`;
}

async function recordOptimizationUsage(args: {
  user_id: string;
  ok: boolean;
  error_code: string | undefined;
  latency_ms: number;
  enabled?: boolean;
}): Promise<void> {
  if (args.enabled === false) return;
  await recordRuntimeUsage({
    user_id: args.user_id,
    agent_id: LUMO_ML_AGENT_ID,
    tool_name: LUMO_OPTIMIZE_TOOL,
    cost_tier: "free" as ToolRoutingEntry["cost_tier"],
    ok: args.ok,
    error_code: args.error_code,
    latency_ms: args.latency_ms,
    system_agent: true,
  });
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(Number(value));
  return Math.min(max, Math.max(min, n));
}
