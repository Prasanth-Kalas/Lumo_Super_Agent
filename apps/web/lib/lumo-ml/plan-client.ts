import type { PlanRequest, PlanResponse, Suggestion } from "@lumo/shared-types";
import { signLumoServiceJwt } from "../service-jwt.ts";

export type PlanResponseResult =
  | {
      ok: true;
      response: PlanResponse;
      latency_ms: number;
      was_stub: boolean;
    }
  | {
      ok: false;
      error: string;
      latency_ms: number;
    };

export interface CallPlanOptions {
  timeout_ms?: number;
  jwt_audience?: string;
  fetchImpl?: typeof fetch;
  mlBaseUrl?: string;
  nowMs?: () => number;
}

const DEFAULT_TIMEOUT_MS = 700;
const DEFAULT_JWT_AUDIENCE = "lumo-ml";
const PLAN_SCOPE = "lumo.plan";

export async function callPlan(
  req: PlanRequest,
  opts: CallPlanOptions = {},
): Promise<PlanResponseResult> {
  const nowMs = opts.nowMs ?? Date.now;
  const started = nowMs();
  const fail = (error: string): PlanResponseResult => ({
    ok: false,
    error,
    latency_ms: elapsedMs(started, nowMs),
  });
  const baseUrl = resolvePlanBaseUrl(opts.mlBaseUrl);
  if (!baseUrl) return fail("plan_not_configured");

  let token: string;
  try {
    token = signLumoServiceJwt({
      audience: opts.jwt_audience ?? DEFAULT_JWT_AUDIENCE,
      user_id: req.user_id || "lumo-orchestrator",
      scope: PLAN_SCOPE,
      ttl_seconds: 60,
    });
  } catch {
    return fail("service_jwt_not_configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, opts.timeout_ms ?? DEFAULT_TIMEOUT_MS),
  );
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${baseUrl}/api/tools/plan`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify(req),
    });
    const latency_ms = elapsedMs(started, nowMs);
    if (!response.ok) {
      return { ok: false, error: `http_${response.status}`, latency_ms };
    }
    const body = await response.json().catch(() => null);
    const parsed = normalizePlanResponse(body);
    if (!parsed) {
      return { ok: false, error: "malformed_response", latency_ms };
    }
    return {
      ok: true,
      response: parsed,
      latency_ms,
      was_stub: response.headers.get("x-lumo-plan-stub") === "1",
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "plan_request_error";
    return fail(name === "AbortError" ? "timeout" : "upstream_error");
  } finally {
    clearTimeout(timeout);
  }
}

function resolvePlanBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.LUMO_ML_AGENT_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:3010" : "");
  return raw.replace(/\/+$/, "");
}

function normalizePlanResponse(value: unknown): PlanResponse | null {
  if (!isRecord(value)) return null;
  const intent_bucket = normalizeIntentBucket(value.intent_bucket);
  const planning_step = normalizePlanningStep(value.planning_step);
  if (!intent_bucket || !planning_step) return null;
  const suggestions = normalizeSuggestions(value.suggestions);
  return {
    intent_bucket,
    planning_step,
    suggestions,
    system_prompt_addendum:
      typeof value.system_prompt_addendum === "string"
        ? value.system_prompt_addendum.slice(0, 2000)
        : null,
    compound_graph: isRecord(value.compound_graph)
      ? (value.compound_graph as unknown as PlanResponse["compound_graph"])
      : null,
    profile_summary_hints: isRecord(value.profile_summary_hints)
      ? (value.profile_summary_hints as unknown as PlanResponse["profile_summary_hints"])
      : null,
  };
}

function normalizeIntentBucket(
  value: unknown,
): PlanResponse["intent_bucket"] | null {
  if (
    value === "fast_path" ||
    value === "tool_path" ||
    value === "reasoning_path"
  ) {
    return value;
  }
  return null;
}

function normalizePlanningStep(
  value: unknown,
): PlanResponse["planning_step"] | null {
  if (
    value === "clarification" ||
    value === "selection" ||
    value === "confirmation" ||
    value === "post_booking"
  ) {
    return value;
  }
  return null;
}

function normalizeSuggestions(value: unknown): PlanResponse["suggestions"] {
  if (!Array.isArray(value)) return [];
  const suggestions: Suggestion[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const rawValue = typeof entry.value === "string" ? entry.value.trim() : "";
    if (!id || !rawValue) continue;
    const label =
      typeof entry.label === "string" && entry.label.trim()
        ? entry.label.trim()
        : rawValue;
    suggestions.push({
      id: id.slice(0, 80),
      label: label.slice(0, 120),
      value: rawValue.slice(0, 240),
    });
    if (suggestions.length >= 4) break;
  }
  return suggestions as PlanResponse["suggestions"];
}

function elapsedMs(started: number, nowMs: () => number): number {
  return Math.max(0, Math.round(nowMs() - started));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
