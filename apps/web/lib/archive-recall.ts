import { createHash, randomUUID } from "node:crypto";
import { getSupabase } from "./db.js";
import { redactForEmbedding } from "./content-indexing.js";
import { recordRuntimeUsage } from "./runtime-policy.js";
import { signLumoServiceJwt } from "./service-jwt.js";
import { createBrainSdkFetch } from "./brain-sdk/index.js";
import {
  recallArchiveCore,
  recallArchiveFallback,
  type ArchiveRecallDocument,
  type ArchiveRecallResult,
} from "./archive-recall-core.js";
import type { ToolRoutingEntry } from "@lumo/agent-sdk";

const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_RECALL_TOOL = "lumo_recall";
const LUMO_EMBED_TOOL = "lumo_embed";
// Two-stage recall is embed (400ms) + pgvector + rerank (500ms), so the
// end-to-end product SLO is 1000ms even though each brain call is tighter.
const RECALL_TIMEOUT_MS = 500;
const EMBED_TIMEOUT_MS = 400;
const DEFAULT_CANDIDATE_LIMIT = 24;
const DEFAULT_TOP_K = 5;

interface MatchContentEmbeddingRow {
  id: string;
  source_table: string;
  source_row_id: number;
  source_etag: string;
  chunk_index: number;
  source_agent_id: string | null;
  endpoint: string | null;
  content_hash: string;
  text: string;
  metadata: Record<string, unknown> | null;
  score: number;
  created_at: string;
}

interface ContentEmbeddingRow {
  id: string;
  source_table: string;
  source_row_id: number;
  source_etag: string;
  chunk_index: number;
  source_agent_id: string | null;
  endpoint: string | null;
  content_hash: string;
  text: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface EmbedResponse {
  model?: string;
  dimensions?: number;
  embeddings?: number[][];
}

export type { ArchiveRecallResult };
export {
  formatArchiveRecallAnswer,
  shouldRunArchiveRecall,
} from "./archive-recall-core.js";

export async function recallFromArchive(args: {
  user_id: string;
  query: string;
  topK?: number;
  candidateLimit?: number;
  fetchImpl?: typeof fetch;
  mlBaseUrl?: string;
  recordUsage?: boolean;
}): Promise<ArchiveRecallResult> {
  const started = Date.now();
  const query = redactForEmbedding(args.query).text;
  const db = getSupabase();
  if (!db) {
    return {
      hits: [],
      status: "disabled",
      source: "fallback",
      latency_ms: Date.now() - started,
      summary: "Archive recall is disabled because persistence is not configured.",
      error: "persistence_disabled",
    };
  }
  if (!args.user_id || args.user_id === "anon") {
    return {
      hits: [],
      status: "disabled",
      source: "fallback",
      latency_ms: Date.now() - started,
      summary: "Archive recall requires an authenticated Lumo user.",
      error: "auth_required",
    };
  }

  const topK = clampInt(args.topK, 1, 20, DEFAULT_TOP_K);
  const candidateLimit = clampInt(args.candidateLimit, topK, 50, DEFAULT_CANDIDATE_LIMIT);
  const baseUrl = resolveMlBaseUrl(args.mlBaseUrl);
  const fetchImpl =
    args.fetchImpl ??
    createBrainSdkFetch({
      user_id: args.user_id,
      baseUrl,
      timeoutMs: Math.max(RECALL_TIMEOUT_MS, EMBED_TIMEOUT_MS),
      callerSurface: "archive-recall",
    });
  const queryEmbedding = await embedRecallQuery({
    user_id: args.user_id,
    query,
    baseUrl,
    fetchImpl,
    recordUsage: args.recordUsage,
  });
  const candidates = queryEmbedding
    ? await vectorCandidates(args.user_id, queryEmbedding, candidateLimit)
    : await recentCandidates(args.user_id, candidateLimit);
  return recallArchiveCore({
    query,
    documents: candidates,
    baseUrl,
    authorizationHeader: serviceAuthorizationHeader({
      baseUrl,
      user_id: args.user_id,
      scope: LUMO_RECALL_TOOL,
    }),
    fetchImpl,
    timeoutMs: RECALL_TIMEOUT_MS,
    topK,
    recordUsage: (ok, error_code, latency_ms) =>
      recordIntelligenceUsage({
        user_id: args.user_id,
        tool_name: LUMO_RECALL_TOOL,
        ok,
        error_code,
        latency_ms,
        enabled: args.recordUsage,
      }),
  });
}

export async function recallFromDocuments(args: {
  query: string;
  documents: ArchiveRecallDocument[];
  topK?: number;
}): Promise<ArchiveRecallResult> {
  const started = Date.now();
  return {
    ...recallArchiveFallback(args.query, args.documents, args.topK ?? DEFAULT_TOP_K),
    source: "fallback",
    latency_ms: Date.now() - started,
  };
}

async function embedRecallQuery(args: {
  user_id: string;
  query: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  recordUsage?: boolean;
}): Promise<number[] | null> {
  const started = Date.now();
  const authorizationHeader = serviceAuthorizationHeader({
    baseUrl: args.baseUrl,
    user_id: args.user_id,
    scope: LUMO_EMBED_TOOL,
  });
  if (!args.baseUrl || !authorizationHeader) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await args.fetchImpl(`${args.baseUrl}/api/tools/embed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authorizationHeader,
        "x-lumo-user-id": args.user_id,
        "x-idempotency-key": `archive-recall:${randomUUID()}`,
      },
      body: JSON.stringify({
        texts: [args.query],
        source_metadata: { source: "archive_recall_query" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      await recordIntelligenceUsage({
        user_id: args.user_id,
        tool_name: LUMO_EMBED_TOOL,
        ok: false,
        error_code: `http_${res.status}`,
        latency_ms,
        enabled: args.recordUsage,
      });
      return null;
    }
    const body = (await res.json()) as EmbedResponse;
    const vector = body.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length !== 384) {
      await recordIntelligenceUsage({
        user_id: args.user_id,
        tool_name: LUMO_EMBED_TOOL,
        ok: false,
        error_code: "malformed_response",
        latency_ms,
        enabled: args.recordUsage,
      });
      return null;
    }
    await recordIntelligenceUsage({
      user_id: args.user_id,
      tool_name: LUMO_EMBED_TOOL,
      ok: true,
      error_code: undefined,
      latency_ms,
      enabled: args.recordUsage,
    });
    return vector;
  } catch (err) {
    clearTimeout(timeout);
    await recordIntelligenceUsage({
      user_id: args.user_id,
      tool_name: LUMO_EMBED_TOOL,
      ok: false,
      error_code:
        err instanceof Error && err.name === "AbortError" ? "timeout" : "upstream_error",
      latency_ms: Date.now() - started,
      enabled: args.recordUsage,
    });
    return null;
  }
}

async function vectorCandidates(
  user_id: string,
  queryEmbedding: number[],
  limit: number,
): Promise<ArchiveRecallDocument[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db.rpc("match_content_embeddings", {
    target_user: user_id,
    query_embedding: toPgVector(queryEmbedding),
    match_count: limit,
  });
  if (error) {
    console.warn("[archive-recall] vector match failed:", {
      user_hash: userHash(user_id),
      message: error.message,
    });
    return recentCandidates(user_id, limit);
  }
  return ((data ?? []) as MatchContentEmbeddingRow[]).map(rowToDocument);
}

async function recentCandidates(
  user_id: string,
  limit: number,
): Promise<ArchiveRecallDocument[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("content_embeddings")
    .select(
      "id, source_table, source_row_id, source_etag, chunk_index, source_agent_id, endpoint, content_hash, text, metadata, created_at",
    )
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[archive-recall] recent candidate read failed:", error.message);
    return [];
  }
  return ((data ?? []) as ContentEmbeddingRow[]).map(rowToDocument);
}

function rowToDocument(row: MatchContentEmbeddingRow | ContentEmbeddingRow): ArchiveRecallDocument {
  return {
    id: row.id,
    text: row.text,
    source: row.source_agent_id,
    metadata: {
      ...(row.metadata ?? {}),
      source_table: row.source_table,
      source_row_id: row.source_row_id,
      source_etag: row.source_etag,
      chunk_index: row.chunk_index,
      endpoint: row.endpoint,
      content_hash: row.content_hash,
      created_at: row.created_at,
    },
  };
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

async function recordIntelligenceUsage(args: {
  user_id: string;
  tool_name: string;
  ok: boolean;
  error_code: string | undefined;
  latency_ms: number;
  enabled?: boolean;
}): Promise<void> {
  if (args.enabled === false) return;
  await recordRuntimeUsage({
    user_id: args.user_id,
    agent_id: LUMO_ML_AGENT_ID,
    tool_name: args.tool_name,
    cost_tier: "free" as ToolRoutingEntry["cost_tier"],
    ok: args.ok,
    error_code: args.error_code,
    latency_ms: args.latency_ms,
    system_agent: true,
  });
}

function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

function userHash(user_id: string): string {
  return createHash("sha256").update(user_id).digest("hex").slice(0, 12);
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
