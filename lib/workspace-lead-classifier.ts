import { signLumoServiceJwt } from "./service-jwt.js";
import { recordRuntimeUsage } from "./runtime-policy.js";
import {
  mergeMlLeadScore,
  scoreLeadHeuristic,
  type LeadScore,
  type MlClassifiedItem,
} from "./lead-scoring.js";

const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_CLASSIFY_TOOL = "lumo_classify";
const CLASSIFY_TIMEOUT_MS = 300;
const CLASSIFY_THRESHOLD = 0.7;

export interface LeadClassifiableItem {
  text: string;
}

export interface LeadClassificationResult {
  scores: LeadScore[];
  source: "ml" | "heuristic";
  latency_ms: number;
  error?: string;
}

interface ClassifyResponse {
  classifier?: string;
  items?: MlClassifiedItem[];
}

export async function classifyLeadItems(
  user_id: string,
  items: LeadClassifiableItem[],
  options: {
    fetchImpl?: typeof fetch;
    mlBaseUrl?: string;
    timeoutMs?: number;
    recordUsage?: boolean;
  } = {},
): Promise<LeadClassificationResult> {
  const started = Date.now();
  const fallback = items.map((item) => scoreLeadHeuristic(item.text));
  if (items.length === 0) {
    return { scores: fallback, source: "heuristic", latency_ms: 0 };
  }

  const baseUrl = (
    options.mlBaseUrl ??
    process.env.LUMO_ML_AGENT_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:3010" : "")
  ).replace(/\/+$/, "");
  if (!baseUrl || !process.env.LUMO_ML_SERVICE_JWT_SECRET) {
    return {
      scores: fallback,
      source: "heuristic",
      latency_ms: Date.now() - started,
      error: "ml_classifier_not_configured",
    };
  }

  const timeoutMs = clampInt(options.timeoutMs, 50, 2000, CLASSIFY_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let error_code: string | undefined;

  try {
    const token = signLumoServiceJwt({
      audience: LUMO_ML_AGENT_ID,
      user_id,
      scope: LUMO_CLASSIFY_TOOL,
      ttl_seconds: 60,
    });
    const res = await (options.fetchImpl ?? fetch)(`${baseUrl}/api/tools/classify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-lumo-user-id": user_id,
      },
      body: JSON.stringify({
        classifier: "lead",
        threshold: CLASSIFY_THRESHOLD,
        items: items.map((item) => item.text).slice(0, 100),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      error_code = `http_${res.status}`;
      await recordClassifierUsage(user_id, false, error_code, latency_ms, options.recordUsage);
      return {
        scores: fallback,
        source: "heuristic",
        latency_ms,
        error: error_code,
      };
    }
    const body = (await res.json()) as ClassifyResponse;
    const mlItems = Array.isArray(body.items) ? body.items : [];
    const scores = fallback.map((score, index) => mergeMlLeadScore(score, mlItems[index]));
    await recordClassifierUsage(user_id, true, undefined, latency_ms, options.recordUsage);
    return { scores, source: "ml", latency_ms };
  } catch (err) {
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    error_code = err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error";
    await recordClassifierUsage(user_id, false, error_code, latency_ms, options.recordUsage);
    return {
      scores: fallback,
      source: "heuristic",
      latency_ms,
      error: error_code,
    };
  }
}

async function recordClassifierUsage(
  user_id: string,
  ok: boolean,
  error_code: string | undefined,
  latency_ms: number,
  enabled = true,
): Promise<void> {
  if (!enabled) return;
  await recordRuntimeUsage({
    user_id,
    agent_id: LUMO_ML_AGENT_ID,
    tool_name: LUMO_CLASSIFY_TOOL,
    cost_tier: "free",
    ok,
    error_code,
    latency_ms,
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
