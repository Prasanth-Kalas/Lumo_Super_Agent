import { randomUUID } from "node:crypto";
import { getSupabase } from "./db.js";
import { signLumoServiceJwt } from "./service-jwt.js";
import {
  buildArchiveTextChunks,
  sourceEtag,
  type ArchiveContentRow,
  type ArchiveTextChunk,
} from "./content-indexing.js";

const SOURCE_TABLE = "connector_responses_archive";
const LUMO_ML_AGENT_ID = "lumo-ml";
const LUMO_EMBED_TOOL = "lumo_embed";
const DEFAULT_ROW_LIMIT = 100;
const DEFAULT_EMBED_BATCH_SIZE = 32;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ArchiveIndexerOptions {
  rowLimit?: number;
  embedBatchSize?: number;
  concurrency?: number;
  dryRun?: boolean;
  mlBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ArchiveIndexerResult {
  ok: boolean;
  skipped?: "persistence_disabled" | "disabled" | "no_rows";
  counts: ArchiveIndexerCounts;
  errors: string[];
}

export interface ArchiveIndexerCounts extends Record<string, number> {
  rows_scanned: number;
  rows_no_text: number;
  rows_embedded: number;
  rows_failed: number;
  chunks_prepared: number;
  chunks_embedded: number;
  embed_batches: number;
  embed_retries: number;
}

interface EmbedResponse {
  model: string;
  dimensions: number;
  embeddings: number[][];
  content_hashes?: string[];
}

interface ChunkWorkItem extends ArchiveTextChunk {
  user_id: string;
  agent_id: string;
  endpoint: string;
  request_hash: string;
}

interface RowState {
  user_id: string;
  agent_id: string;
  endpoint: string;
  source_etag: string;
  total: number;
  embedded: number;
  error: string | null;
}

export async function indexConnectorArchive(
  options: ArchiveIndexerOptions = {},
): Promise<ArchiveIndexerResult> {
  const db = getSupabase();
  const counts: ArchiveIndexerCounts = {
    rows_scanned: 0,
    rows_no_text: 0,
    rows_embedded: 0,
    rows_failed: 0,
    chunks_prepared: 0,
    chunks_embedded: 0,
    embed_batches: 0,
    embed_retries: 0,
  };
  const errors: string[] = [];

  if (!db) {
    return { ok: true, skipped: "persistence_disabled", counts, errors };
  }

  const rowLimit = clampInt(options.rowLimit, 1, 500, DEFAULT_ROW_LIMIT);
  const { data, error } = await db.rpc("next_connector_archive_embedding_batch", {
    requested_limit: rowLimit,
  });
  if (error) {
    return {
      ok: false,
      counts,
      errors: [`candidate query: ${error.message}`],
    };
  }

  const rows = ((data ?? []) as ArchiveContentRow[]).slice(0, rowLimit);
  counts.rows_scanned = rows.length;
  if (rows.length === 0) {
    return { ok: true, skipped: "no_rows", counts, errors };
  }

  const rowStates = new Map<string, RowState>();
  const chunks: ChunkWorkItem[] = [];
  for (const row of rows) {
    const rowChunks = buildArchiveTextChunks(row);
    const rowId = String(row.id);
    const source_etag = rowChunks[0]?.source_etag ?? sourceEtag(row);
    if (rowChunks.length === 0) {
      counts.rows_no_text += 1;
      if (!options.dryRun) {
        await markSourceState({
          source_row_id: rowId,
          user_id: row.user_id,
          agent_id: row.agent_id,
          endpoint: row.endpoint,
          source_etag,
          status: "no_text",
          chunk_count: 0,
          last_error: null,
        });
      }
      continue;
    }
    rowStates.set(rowId, {
      user_id: row.user_id,
      agent_id: row.agent_id,
      endpoint: row.endpoint,
      source_etag,
      total: rowChunks.length,
      embedded: 0,
      error: null,
    });
    for (const chunk of rowChunks) {
      chunks.push({
        ...chunk,
        user_id: row.user_id,
        agent_id: row.agent_id,
        endpoint: row.endpoint,
        request_hash: row.request_hash,
      });
    }
  }

  counts.chunks_prepared = chunks.length;
  if (options.dryRun || chunks.length === 0) {
    return { ok: true, counts, errors };
  }

  const batches = makeEmbedBatches(chunks, {
    batchSize: clampInt(options.embedBatchSize, 1, 128, DEFAULT_EMBED_BATCH_SIZE),
  });
  const concurrency = clampInt(options.concurrency, 1, 12, DEFAULT_CONCURRENCY);
  await runWithConcurrency(batches, concurrency, async (batch) => {
    counts.embed_batches += 1;
    try {
      const embedded = await embedBatch(batch, options, counts);
      await upsertEmbeddings(batch, embedded);
      counts.chunks_embedded += batch.length;
      for (const chunk of batch) {
        const state = rowStates.get(chunk.source_row_id);
        if (state) state.embedded += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message.slice(0, 240));
      for (const chunk of batch) {
        const state = rowStates.get(chunk.source_row_id);
        if (state) state.error = message;
      }
    }
  });

  for (const [source_row_id, state] of rowStates) {
    const embedded = state.embedded === state.total;
    if (embedded) {
      counts.rows_embedded += 1;
      await deleteStaleEmbeddings(source_row_id, state.source_etag);
    } else {
      counts.rows_failed += 1;
    }
    await markSourceState({
      source_row_id,
      user_id: state.user_id,
      agent_id: state.agent_id,
      endpoint: state.endpoint,
      source_etag: state.source_etag,
      status: embedded ? "embedded" : "failed",
      chunk_count: state.embedded,
      last_error: embedded ? null : state.error ?? "embedding batch failed",
    });
  }

  return { ok: errors.length === 0, counts, errors: errors.slice(0, 10) };
}

function makeEmbedBatches(
  chunks: ChunkWorkItem[],
  options: { batchSize: number },
): ChunkWorkItem[][] {
  const byUser = new Map<string, ChunkWorkItem[]>();
  for (const chunk of chunks) {
    const group = byUser.get(chunk.user_id) ?? [];
    group.push(chunk);
    byUser.set(chunk.user_id, group);
  }

  const batches: ChunkWorkItem[][] = [];
  for (const group of byUser.values()) {
    for (let i = 0; i < group.length; i += options.batchSize) {
      batches.push(group.slice(i, i + options.batchSize));
    }
  }
  return batches;
}

async function embedBatch(
  batch: ChunkWorkItem[],
  options: ArchiveIndexerOptions,
  counts: ArchiveIndexerCounts,
): Promise<EmbedResponse> {
  const user_id = batch[0]?.user_id;
  if (!user_id) throw new Error("empty embed batch");
  const baseUrl = (options.mlBaseUrl ?? process.env.LUMO_ML_AGENT_URL ?? "http://localhost:3010")
    .replace(/\/+$/, "");
  const url = `${baseUrl}/api/tools/embed`;
  const fetcher = options.fetchImpl ?? fetch;
  const token = signLumoServiceJwt({
    audience: LUMO_ML_AGENT_ID,
    user_id,
    scope: LUMO_EMBED_TOOL,
    request_id: randomUUID(),
    ttl_seconds: 120,
  });
  const payload = {
    texts: batch.map((chunk) => chunk.text),
    source_metadata: {
      source: SOURCE_TABLE,
      row_count: new Set(batch.map((chunk) => chunk.source_row_id)).size,
      chunk_count: batch.length,
    },
  };

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-lumo-user-id": user_id,
          "x-idempotency-key": `archive-index:${batch[0]?.source_row_id}:${attempt}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const body = (await res.json()) as EmbedResponse;
        if (!Array.isArray(body.embeddings) || body.embeddings.length !== batch.length) {
          throw new Error(`embed returned ${body.embeddings?.length ?? 0}/${batch.length} vectors`);
        }
        return body;
      }
      const detail = await safeText(res);
      lastError = `embed HTTP ${res.status}: ${detail.slice(0, 160)}`;
      if (res.status !== 429 && res.status !== 503 && res.status !== 504) break;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 2) {
      counts.embed_retries += 1;
      await sleep(250 * (attempt + 1) + Math.floor(Math.random() * 100));
    }
  }
  throw new Error(lastError ?? "embed failed");
}

async function upsertEmbeddings(
  batch: ChunkWorkItem[],
  response: EmbedResponse,
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const rows = batch.map((chunk, i) => ({
    user_id: chunk.user_id,
    source_table: SOURCE_TABLE,
    source_row_id: chunk.source_row_id,
    source_etag: chunk.source_etag,
    chunk_index: chunk.chunk_index,
    source_agent_id: chunk.agent_id,
    endpoint: chunk.endpoint,
    request_hash: chunk.request_hash,
    content_hash: chunk.content_hash,
    text: chunk.text,
    metadata: chunk.metadata,
    embedding: toPgVector(response.embeddings[i] ?? []),
    model: response.model,
    dimensions: response.dimensions,
  }));

  const { error } = await db
    .from("content_embeddings")
    .upsert(rows, {
      onConflict: "source_table,source_row_id,source_etag,chunk_index",
    });
  if (error) throw new Error(`embedding upsert: ${error.message}`);
}

async function markSourceState(args: {
  source_row_id: string;
  user_id: string;
  agent_id: string;
  endpoint: string;
  source_etag: string;
  status: "embedded" | "no_text" | "failed";
  chunk_count: number;
  last_error: string | null;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from("content_embedding_sources").upsert({
    source_table: SOURCE_TABLE,
    source_row_id: args.source_row_id,
    user_id: args.user_id,
    source_agent_id: args.agent_id,
    endpoint: args.endpoint,
    source_etag: args.source_etag,
    status: args.status,
    chunk_count: args.chunk_count,
    last_error: args.last_error ? args.last_error.slice(0, 500) : null,
    indexed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`source-state upsert: ${error.message}`);
}

async function deleteStaleEmbeddings(
  source_row_id: string,
  source_etag: string,
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db
    .from("content_embeddings")
    .delete()
    .eq("source_table", SOURCE_TABLE)
    .eq("source_row_id", source_row_id)
    .neq("source_etag", source_etag);
  if (error) {
    console.warn("[content-indexer] stale embedding cleanup failed:", error.message);
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}

function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
