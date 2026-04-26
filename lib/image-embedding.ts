import type { ToolRoutingEntry } from "@lumo/agent-sdk";
import { recordRuntimeUsage } from "./runtime-policy.js";
import { signLumoServiceJwt } from "./service-jwt.js";
import {
  embedImageCore,
  type EmbedImageInput,
  type EmbedImageResult,
} from "./image-embedding-core.js";

const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_EMBED_IMAGE_TOOL = "lumo_embed_image";
const EMBED_IMAGE_TIMEOUT_MS = 120_000;

export type { EmbedImageInput, EmbedImageResult };

export async function embedImage(args: {
  user_id: string;
  input: EmbedImageInput;
  fetchImpl?: typeof fetch;
  mlBaseUrl?: string;
  timeoutMs?: number;
  recordUsage?: boolean;
}): Promise<EmbedImageResult> {
  const baseUrl = resolveMlBaseUrl(args.mlBaseUrl);
  const authorizationHeader = serviceAuthorizationHeader({
    baseUrl,
    user_id: args.user_id,
    scope: LUMO_EMBED_IMAGE_TOOL,
  });
  return embedImageCore({
    input: args.input,
    baseUrl,
    authorizationHeader,
    fetchImpl: args.fetchImpl ?? fetch,
    timeoutMs: clampInt(args.timeoutMs, 1_000, 300_000, EMBED_IMAGE_TIMEOUT_MS),
    recordUsage: (ok, error_code, latency_ms) =>
      recordImageEmbeddingUsage({
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
    ttl_seconds: 120,
  })}`;
}

async function recordImageEmbeddingUsage(args: {
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
    tool_name: LUMO_EMBED_IMAGE_TOOL,
    cost_tier: "metered" as ToolRoutingEntry["cost_tier"],
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
