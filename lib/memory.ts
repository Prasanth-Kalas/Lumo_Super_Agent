/**
 * Memory DAO — user_profile, user_facts, user_behavior_patterns.
 *
 * This is the single entry point for every read/write of what the Super
 * Agent "knows" about a user. Invariants:
 *
 *   - All reads filter out soft-deleted facts (`deleted_at is null`).
 *   - Writes embed the fact text via lib/embeddings; null vectors are
 *     tolerated (degraded retrieval) not rejected.
 *   - Retrieval combines semantic similarity with recency so a stale
 *     but semantically-matching fact doesn't outrank a newly-confirmed
 *     one. See retrieveRelevantFacts for the scoring formula.
 *   - Profile updates are merge-patched — callers pass only the fields
 *     they want to change; null/undefined leaves the existing value.
 *
 * Privacy posture:
 *   - The service-role Supabase client talks to these tables. No
 *     browser path reads here directly.
 *   - `forgetFact` is soft-delete by default (reversible within 30 days);
 *     `forgetEverything` is the hard-delete the user can trigger
 *     manually and it's irreversible.
 */

import { randomBytes } from "node:crypto";
import { getSupabase } from "./db.js";
import { embed, toPgVector } from "./embeddings.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  display_name: string | null;
  timezone: string | null;
  preferred_language: string | null;
  home_address: AddressPayload | null;
  work_address: AddressPayload | null;
  dietary_flags: string[];
  allergies: string[];
  preferred_cuisines: string[];
  preferred_airline_class: string | null;
  preferred_airline_seat: string | null;
  frequent_flyer_numbers: Record<string, string> | null;
  preferred_hotel_chains: string[];
  budget_tier: string | null;
  preferred_payment_hint: string | null;
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AddressPayload {
  label?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  country?: string;
  postal_code?: string;
  coords?: { lat: number; lng: number };
}

export type FactCategory =
  | "preference"
  | "identity"
  | "habit"
  | "location"
  | "constraint"
  | "context"
  | "milestone"
  | "other";

export type FactSource = "explicit" | "inferred" | "behavioral";

export interface UserFact {
  id: string;
  user_id: string;
  fact: string;
  category: FactCategory;
  source: FactSource;
  confidence: number;
  supersedes_id: string | null;
  first_seen_at: string;
  last_confirmed_at: string;
  updated_at: string;
}

export interface BehaviorPattern {
  id: string;
  user_id: string;
  pattern_kind: string;
  description: string;
  evidence_count: number;
  confidence: number;
  first_observed_at: string;
  last_observed_at: string;
}

export class MemoryError extends Error {
  readonly code: "persistence_disabled" | "not_found" | "invalid_input";
  constructor(code: MemoryError["code"], message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Profile
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read a user's profile. The tg_handle_new_profile trigger auto-creates
 * an empty row on user signup, so this should always return a row for
 * an authenticated user. If it doesn't, we insert-on-miss and return
 * the empty shell rather than making every caller handle null.
 */
export async function getProfile(userId: string): Promise<UserProfile | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data, error } = await db
    .from("user_profile")
    .select("*")
    .eq("id", userId)
    .limit(1);

  if (error) {
    console.error("[memory] getProfile failed:", error.message);
    return null;
  }
  const row = data?.[0];
  if (row) return rowToProfile(row);

  // Self-heal: trigger should have run on signup, but if this is an
  // older user whose profile was created before migration 005, upsert
  // an empty shell.
  const { data: inserted, error: insErr } = await db
    .from("user_profile")
    .insert({ id: userId })
    .select("*")
    .single();
  if (insErr || !inserted) {
    console.error("[memory] getProfile self-heal insert failed:", insErr?.message);
    return null;
  }
  return rowToProfile(inserted);
}

/**
 * Merge-patch the profile. Only fields explicitly passed in `patch` are
 * updated — undefined leaves the DB value alone; explicit null clears it.
 *
 * Returns the updated row.
 */
export async function upsertProfile(
  userId: string,
  patch: Partial<Omit<UserProfile, "id" | "created_at" | "updated_at">>,
): Promise<UserProfile | null> {
  const db = getSupabase();
  if (!db) throw new MemoryError("persistence_disabled", "Supabase not configured.");

  // Build a patch object that only contains keys the caller explicitly
  // named. `undefined` is dropped; `null` is preserved as an explicit
  // clear.
  const dbPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    dbPatch[k] = v;
  }
  if (Object.keys(dbPatch).length === 0) {
    return await getProfile(userId);
  }

  const { data, error } = await db
    .from("user_profile")
    .update(dbPatch)
    .eq("id", userId)
    .select("*")
    .single();

  if (error || !data) {
    console.error("[memory] upsertProfile failed:", error?.message);
    return null;
  }
  return rowToProfile(data);
}

// ──────────────────────────────────────────────────────────────────────────
// Facts — write
// ──────────────────────────────────────────────────────────────────────────

/**
 * Save a fact. Embeds the fact text (best-effort) and inserts.
 *
 * Dedup policy: we don't currently de-dup before insert; duplicate/near-
 * duplicate facts are acceptable because retrieval ranks by recency anyway
 * and the /memory UI lets users consolidate. When we add a nightly
 * consolidation job we'll revisit.
 *
 * `supersedes_id` is optional — use it when the new fact explicitly
 * replaces an older one (the older stays in the DB for history).
 */
export async function saveFact(args: {
  user_id: string;
  fact: string;
  category: FactCategory;
  source?: FactSource;
  confidence?: number;
  supersedes_id?: string | null;
}): Promise<UserFact> {
  const db = getSupabase();
  if (!db) throw new MemoryError("persistence_disabled", "Supabase not configured.");

  const fact = args.fact.trim();
  if (fact.length < 3 || fact.length > 2000) {
    throw new MemoryError("invalid_input", "Fact must be 3..2000 chars.");
  }

  const id = `fact_${randomBytes(9).toString("base64url")}`;
  const vec = await embed(fact);

  const row: Record<string, unknown> = {
    id,
    user_id: args.user_id,
    fact,
    category: args.category,
    source: args.source ?? "explicit",
    confidence: args.confidence ?? 1.0,
    supersedes_id: args.supersedes_id ?? null,
  };
  if (vec) row.embedding = toPgVector(vec);

  const { data, error } = await db
    .from("user_facts")
    .insert(row)
    .select("id, user_id, fact, category, source, confidence, supersedes_id, first_seen_at, last_confirmed_at, updated_at")
    .single();

  if (error || !data) {
    throw new MemoryError(
      "invalid_input",
      `saveFact: ${error?.message ?? "unknown error"}`,
    );
  }
  return rowToFact(data);
}

/**
 * Soft-delete a fact. The fact stays in the table with deleted_at set;
 * retrieval filters it out. Call hardDeleteFact (or use
 * forgetEverything) to actually purge.
 */
export async function forgetFact(userId: string, factId: string): Promise<void> {
  const db = getSupabase();
  if (!db) throw new MemoryError("persistence_disabled", "Supabase not configured.");

  const { error } = await db
    .from("user_facts")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", factId)
    .eq("user_id", userId)
    .is("deleted_at", null);

  if (error) {
    throw new MemoryError("invalid_input", `forgetFact: ${error.message}`);
  }
}

/**
 * "Forget everything Lumo knows about me." Calls the forget_everything
 * stored proc that wipes facts, patterns, and empties the profile shell.
 * Irreversible. Surface a confirmation dialog before invoking.
 */
export async function forgetEverything(userId: string): Promise<void> {
  const db = getSupabase();
  if (!db) throw new MemoryError("persistence_disabled", "Supabase not configured.");
  const { error } = await db.rpc("forget_everything", { target_user: userId });
  if (error) {
    throw new MemoryError("invalid_input", `forgetEverything: ${error.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Facts — read / retrieve
// ──────────────────────────────────────────────────────────────────────────

/**
 * List live facts for the user, most-recently-confirmed first. For the
 * /memory UI — not the orchestrator hot path (use retrieveRelevantFacts
 * there).
 */
export async function listFacts(
  userId: string,
  opts?: { category?: FactCategory; limit?: number },
): Promise<UserFact[]> {
  const db = getSupabase();
  if (!db) return [];

  let q = db
    .from("user_facts")
    .select(
      "id, user_id, fact, category, source, confidence, supersedes_id, first_seen_at, last_confirmed_at, updated_at",
    )
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("last_confirmed_at", { ascending: false })
    .limit(opts?.limit ?? 200);

  if (opts?.category) q = q.eq("category", opts.category);

  const { data, error } = await q;
  if (error) {
    console.error("[memory] listFacts failed:", error.message);
    return [];
  }
  return (data ?? []).map(rowToFact);
}

/**
 * Retrieval for the orchestrator. Given a user query (typically the
 * latest user message), return the top-K facts most likely to be
 * relevant.
 *
 * Scoring: 0.8 * semantic_similarity + 0.2 * recency_weight
 *
 *   semantic_similarity = 1 - cosine_distance(fact.embedding, query.embedding)
 *                         (clamped to [0, 1])
 *   recency_weight      = exp(-age_days / 7)   # 7-day half-life-ish
 *
 * Fall-back: if no query embedding is available (OPENAI_API_KEY unset
 * or the call failed), we return the K most-recently-confirmed facts.
 * That's not as smart, but it's coherent.
 */
export async function retrieveRelevantFacts(
  userId: string,
  query: string,
  k = 8,
): Promise<UserFact[]> {
  const db = getSupabase();
  if (!db) return [];

  const qvec = await embed(query);
  if (!qvec) {
    // Fallback: recency-only
    return listFacts(userId, { limit: k });
  }

  // We compute the score in SQL via an RPC that we don't have yet.
  // For MVP, we pull a candidate window (most recent 50) and score
  // in Node. Candidate size is bounded so this is O(50) per turn.
  // When row counts grow or we prove the pattern, move to an RPC
  // that does the math in Postgres.
  const { data, error } = await db
    .from("user_facts")
    .select(
      "id, user_id, fact, category, source, confidence, supersedes_id, first_seen_at, last_confirmed_at, updated_at, embedding",
    )
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("last_confirmed_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[memory] retrieveRelevantFacts read failed:", error.message);
    return [];
  }

  const now = Date.now();
  const scored = (data ?? []).map((r) => {
    const fact = rowToFact(r);
    const embedding = parseEmbedding((r as { embedding?: unknown }).embedding);
    const sim = embedding ? 1 - cosineDistance(qvec, embedding) : 0;
    const clampedSim = Math.max(0, Math.min(1, sim));
    const ageDays =
      (now - new Date(fact.last_confirmed_at).getTime()) / (1000 * 60 * 60 * 24);
    const recency = Math.exp(-Math.max(0, ageDays) / 7);
    const score = 0.8 * clampedSim + 0.2 * recency;
    return { fact, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((x) => x.fact);
}

/**
 * Behavior patterns read — high-confidence ones only. Used alongside
 * facts in the orchestrator system prompt.
 */
export async function listHighConfidencePatterns(
  userId: string,
  minConfidence = 0.7,
  limit = 10,
): Promise<BehaviorPattern[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("user_behavior_patterns")
    .select(
      "id, user_id, pattern_kind, description, evidence_count, confidence, first_observed_at, last_observed_at",
    )
    .eq("user_id", userId)
    .gte("confidence", minConfidence)
    .order("confidence", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[memory] listHighConfidencePatterns failed:", error.message);
    return [];
  }
  return (data ?? []) as BehaviorPattern[];
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

function rowToProfile(row: Record<string, unknown>): UserProfile {
  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : [];
  return {
    id: String(row.id),
    display_name: (row.display_name as string) ?? null,
    timezone: (row.timezone as string) ?? null,
    preferred_language: (row.preferred_language as string) ?? null,
    home_address: (row.home_address as AddressPayload) ?? null,
    work_address: (row.work_address as AddressPayload) ?? null,
    dietary_flags: asArray(row.dietary_flags),
    allergies: asArray(row.allergies),
    preferred_cuisines: asArray(row.preferred_cuisines),
    preferred_airline_class: (row.preferred_airline_class as string) ?? null,
    preferred_airline_seat: (row.preferred_airline_seat as string) ?? null,
    frequent_flyer_numbers:
      (row.frequent_flyer_numbers as Record<string, string>) ?? null,
    preferred_hotel_chains: asArray(row.preferred_hotel_chains),
    budget_tier: (row.budget_tier as string) ?? null,
    preferred_payment_hint: (row.preferred_payment_hint as string) ?? null,
    extra: (row.extra as Record<string, unknown>) ?? {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToFact(row: Record<string, unknown>): UserFact {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    fact: String(row.fact),
    category: row.category as FactCategory,
    source: row.source as FactSource,
    confidence: Number(row.confidence),
    supersedes_id: (row.supersedes_id as string) ?? null,
    first_seen_at: String(row.first_seen_at),
    last_confirmed_at: String(row.last_confirmed_at),
    updated_at: String(row.updated_at),
  };
}

function parseEmbedding(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw !== "string") return null;
  // pgvector text form "[0.01,0.02,...]"
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1);
  if (!body) return [];
  const parts = body.split(",");
  const out: number[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (Number.isNaN(n)) return null;
    out[i] = n;
  }
  return out;
}

/**
 * Standard cosine distance. Returns a value in [0, 2] where 0 is
 * identical and 1 is orthogonal. We clamp to [0, 1] at the caller
 * because negative dot products (rare in normalized embedding space
 * but possible) would push similarity above 1.
 */
function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
