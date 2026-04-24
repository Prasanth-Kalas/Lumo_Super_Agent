/**
 * Embeddings helper — OpenAI text-embedding-3-small (1536 dim).
 *
 * Used by lib/memory.ts to embed facts on write and queries on retrieve.
 *
 * Graceful fallback: if OPENAI_API_KEY is not set, `embed()` returns
 * null and the memory layer falls back to recency-based retrieval. That
 * keeps local dev and free-tier prod working without a paid OpenAI
 * account, at the cost of not-quite-as-good fact recall.
 *
 * In-process cache: we hash (model, text) and memoize the vector for
 * the life of the Node process. Memories repeat ("user lives in San
 * Francisco") and embedding the same string every turn would be waste.
 * The cache is small — per-process, bounded to 500 entries via LRU
 * eviction — so it won't grow unbounded in a long-lived serverless
 * warm instance.
 *
 * Why text-embedding-3-small and not large:
 *   - 1536 dims is the pgvector sweet spot for IVFFlat (lists=100).
 *   - Cost: ~$0.00002 / 1K tokens — negligible for our write volume.
 *   - Quality delta vs large is real but not product-defining for
 *     remembering short personal facts. Revisit if recall quality
 *     becomes the bottleneck.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";

const MODEL = "text-embedding-3-small";
const DIM = 1536;

// Small LRU. Map preserves insertion order; we evict the oldest on overflow.
const cache = new Map<string, number[]>();
const CACHE_MAX = 500;

let cachedClient: OpenAI | null | undefined;
function getClient(): OpenAI | null {
  if (cachedClient !== undefined) return cachedClient;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    cachedClient = null;
    console.warn(
      "[embeddings] OPENAI_API_KEY not set — memory retrieval will fall back " +
        "to recency-only. Set it to enable semantic recall.",
    );
    return null;
  }
  cachedClient = new OpenAI({ apiKey: key });
  return cachedClient;
}

/**
 * Embed a single string. Returns a 1536-dim vector on success, null if
 * OpenAI isn't configured or the call fails. Callers must handle null
 * — treat it as "embedding unavailable" and proceed with a lesser
 * retrieval strategy.
 */
export async function embed(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const key = hashKey(MODEL, trimmed);
  const hit = cache.get(key);
  if (hit) {
    // LRU touch: re-insert so it sorts to the front.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const client = getClient();
  if (!client) return null;

  try {
    const res = await client.embeddings.create({
      model: MODEL,
      input: trimmed,
      // We explicitly ask for 1536 dims. For text-embedding-3-small this
      // is the native size; for -large we'd pass 1536 to truncate and
      // keep pgvector happy.
      dimensions: DIM,
    });
    const vec = res.data[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== DIM) {
      console.warn("[embeddings] unexpected embedding shape:", vec?.length);
      return null;
    }
    // LRU insert.
    if (cache.size >= CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, vec);
    return vec;
  } catch (err) {
    console.warn(
      "[embeddings] embed failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Batch embed. Same fall-back semantics: on failure returns array of
 * nulls matching input order. Useful for the nightly pattern-detection
 * job that needs to re-embed many facts at once.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const client = getClient();
  if (!client) return results;

  // Pull cache hits first so we only pay for the misses.
  const toFetchIndices: number[] = [];
  const toFetchTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]?.trim();
    if (!t) continue;
    const k = hashKey(MODEL, t);
    const hit = cache.get(k);
    if (hit) {
      results[i] = hit;
      cache.delete(k);
      cache.set(k, hit);
    } else {
      toFetchIndices.push(i);
      toFetchTexts.push(t);
    }
  }

  if (toFetchTexts.length === 0) return results;

  try {
    const res = await client.embeddings.create({
      model: MODEL,
      input: toFetchTexts,
      dimensions: DIM,
    });
    for (let j = 0; j < res.data.length; j++) {
      const v = res.data[j]?.embedding;
      const origIdx = toFetchIndices[j];
      if (origIdx === undefined || !Array.isArray(v) || v.length !== DIM) continue;
      results[origIdx] = v;
      const text = toFetchTexts[j];
      if (text) {
        if (cache.size >= CACHE_MAX) {
          const firstKey = cache.keys().next().value;
          if (firstKey !== undefined) cache.delete(firstKey);
        }
        cache.set(hashKey(MODEL, text), v);
      }
    }
  } catch (err) {
    console.warn(
      "[embeddings] embedBatch failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return results;
}

/**
 * Convert a JS number array into the pgvector string literal format:
 *   "[0.01,0.02,...]"
 *
 * Supabase JS client can accept this as a text parameter that Postgres
 * will coerce to vector. Using the literal form rather than a typed
 * array lets us use the standard PostgREST insert/update path.
 */
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * Inverse: parse pgvector's text output back into a number array. Used
 * in the rare path where we read back an embedding (e.g., pattern
 * detection re-clustering).
 */
export function fromPgVector(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1);
  if (!body) return [];
  const parts = body.split(",");
  const out: number[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) return null;
    const n = Number(part);
    if (Number.isNaN(n)) return null;
    out[i] = n;
  }
  return out;
}

function hashKey(model: string, text: string): string {
  return `${model}:${createHash("sha256").update(text).digest("hex")}`;
}

export function __resetEmbeddingCacheForTesting(): void {
  cache.clear();
  cachedClient = undefined;
}

export { MODEL as EMBEDDING_MODEL, DIM as EMBEDDING_DIM };
