import { signLumoServiceJwt } from "./service-jwt.js";
import { recordRuntimeUsage } from "./runtime-policy.js";
import { redactForEmbedding } from "./content-indexing.js";
import { classifyLeadItemsCore } from "./workspace-lead-classifier-core.js";
import {
  LEAD_SCORE_THRESHOLD,
  scoreLeadHeuristic,
  type LeadScore,
} from "./lead-scoring.js";

const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_CLASSIFY_TOOL = "lumo_classify";
const CLASSIFY_TIMEOUT_MS = 300;
const CLASSIFY_ITEM_CAP = 100;

export interface LeadClassifiableItem {
  text: string;
}

export interface LeadClassificationResult {
  scores: LeadScore[];
  source: "ml" | "heuristic";
  latency_ms: number;
  error?: string;
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
  const fallback = items.map((item) => scoreLeadHeuristic(item.text));
  if (items.length === 0) {
    return { scores: fallback, source: "heuristic", latency_ms: 0 };
  }

  const baseUrl = (
    options.mlBaseUrl ??
    process.env.LUMO_ML_AGENT_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:3010" : "")
  ).replace(/\/+$/, "");
  const timeoutMs = clampInt(options.timeoutMs, 50, 2000, CLASSIFY_TIMEOUT_MS);
  const authHeader = baseUrl && process.env.LUMO_ML_SERVICE_JWT_SECRET
    ? `Bearer ${signLumoServiceJwt({
      audience: LUMO_ML_AGENT_ID,
      user_id,
      scope: LUMO_CLASSIFY_TOOL,
      ttl_seconds: 60,
    })}`
    : null;

  return classifyLeadItemsCore({
    user_id,
    redactedTexts: items.map((item) => redactForEmbedding(item.text).text),
    fallbackScores: fallback,
    baseUrl,
    authorizationHeader: authHeader,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs,
    threshold: LEAD_SCORE_THRESHOLD,
    itemCap: CLASSIFY_ITEM_CAP,
    warn: (message) => console.warn(message),
    recordUsage: (ok, error_code, latency_ms) =>
      recordClassifierUsage(user_id, ok, error_code, latency_ms, options.recordUsage),
  });
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
