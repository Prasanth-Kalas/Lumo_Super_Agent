import type { ToolRoutingEntry } from "@lumo/agent-sdk";
import { recordRuntimeUsage } from "./runtime-policy.js";
import { signLumoServiceJwt } from "./service-jwt.js";
import {
  transcribeAudioCore,
  type TranscribeAudioInput,
  type TranscribeAudioResult,
} from "./audio-transcription-core.js";

const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_TRANSCRIBE_TOOL = "lumo_transcribe";
const TRANSCRIBE_TIMEOUT_MS = 60_000;

export type { TranscribeAudioInput, TranscribeAudioResult };

export async function transcribeAudio(args: {
  user_id: string;
  input: TranscribeAudioInput;
  fetchImpl?: typeof fetch;
  mlBaseUrl?: string;
  timeoutMs?: number;
  recordUsage?: boolean;
}): Promise<TranscribeAudioResult> {
  const baseUrl = resolveMlBaseUrl(args.mlBaseUrl);
  const authorizationHeader = serviceAuthorizationHeader({
    baseUrl,
    user_id: args.user_id,
    scope: LUMO_TRANSCRIBE_TOOL,
  });
  return transcribeAudioCore({
    input: args.input,
    baseUrl,
    authorizationHeader,
    fetchImpl: args.fetchImpl ?? fetch,
    timeoutMs: clampInt(args.timeoutMs, 1_000, 300_000, TRANSCRIBE_TIMEOUT_MS),
    recordUsage: (ok, error_code, latency_ms) =>
      recordTranscriptionUsage({
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

async function recordTranscriptionUsage(args: {
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
    tool_name: LUMO_TRANSCRIBE_TOOL,
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
