/**
 * GET /api/cron/detect-patterns
 *
 * Nightly (03:00 UTC). For each user with activity in the last 30 days,
 * pull their recent tool-call and trip events and ask Claude to name
 * 1–5 recurring behavioral patterns. High-confidence results upsert
 * into user_behavior_patterns so the orchestrator's memory-retrieval
 * layer can fold "observed this Fri-evening pattern 11 times" into
 * the system prompt on the next turn.
 *
 * Design notes:
 *
 *   - We cap per-run user set at 500 and per-user event window at 300
 *     rows. That bounds the worst-case Claude token spend and keeps
 *     any one slow user from blowing the 60s function budget. A user
 *     who just happened to generate 5k events in 30 days gets the
 *     most recent 300 — the older ones would have contributed the
 *     same patterns anyway.
 *
 *   - We ONLY upsert patterns with Claude-reported confidence ≥ 0.7.
 *     Below that it's too speculative to be useful in a prompt and
 *     risks priming the model with wrong priors.
 *
 *   - Upsert key is (user_id, pattern_kind, description_trimmed) —
 *     same pattern detected two nights running just bumps
 *     evidence_count + last_observed_at rather than inserting a dupe.
 *     NOT implemented via a DB unique constraint (description is
 *     free-text, Claude may phrase it differently night to night);
 *     instead we do a fuzzy match in Node before insert.
 *
 *   - Auth: same CRON_SECRET bearer pattern as the other crons.
 */

import type { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { getSupabase } from "@/lib/db";
import { recordCronRun } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Claude model for pattern detection. Sonnet is plenty — pattern-ID
// from 300 rows of structured events doesn't need Opus reasoning.
const MODEL = "claude-sonnet-4-6";

// Guardrails
const MAX_USERS_PER_RUN = 500;
const MAX_EVENTS_PER_USER = 300;
const MIN_CONFIDENCE = 0.7;
const MAX_PATTERNS_PER_USER = 8;

export async function GET(req: NextRequest): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return json({ error: "cron_secret_missing" }, 503);
  }
  const got = req.headers.get("authorization") ?? "";
  if (got !== `Bearer ${expected}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const db = getSupabase();
  if (!db) return json({ ok: false, reason: "persistence_disabled" }, 200);

  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ ok: false, reason: "anthropic_key_missing" }, 200);
  }

  const started = Date.now();

  // 1) Find active users from the events table. "Active" = at least one
  //    event in the last 30 days. Cap at MAX_USERS_PER_RUN.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: activeRows, error: aErr } = await db
    .from("events")
    .select("session_id, ts")
    .gt("ts", since)
    .order("ts", { ascending: false })
    .limit(5000); // bounded read; we de-dup sessions per user below
  if (aErr) {
    return json({ ok: false, error: aErr.message }, 200);
  }

  // Events are keyed by session_id; we need user_id. Join via trips.
  // Trips.user_id is text (per migration 001) and maps back to the
  // Supabase user uuid as a string.
  const sessionIds = Array.from(
    new Set((activeRows ?? []).map((r) => String((r as { session_id?: string }).session_id)))
  ).slice(0, 5000);

  let userIds: string[] = [];
  if (sessionIds.length > 0) {
    const { data: tripUsers } = await db
      .from("trips")
      .select("session_id, user_id")
      .in("session_id", sessionIds);
    userIds = Array.from(
      new Set(
        (tripUsers ?? [])
          .map((r) => String((r as { user_id?: string }).user_id ?? ""))
          .filter(Boolean),
      ),
    ).slice(0, MAX_USERS_PER_RUN);
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let usersScanned = 0;
  let patternsUpserted = 0;
  const errors: string[] = [];

  for (const user_id of userIds) {
    try {
      const patterns = await detectForUser(db, anthropic, user_id);
      for (const p of patterns) {
        const inserted = await upsertPattern(db, user_id, p);
        if (inserted) patternsUpserted++;
      }
      usersScanned++;
    } catch (err) {
      errors.push(`${user_id}:${err instanceof Error ? err.message : String(err)}`);
    }
    // Soft deadline — don't overrun the function budget.
    if (Date.now() - started > 50_000) break;
  }

  const ok = errors.length === 0;
  void recordCronRun({
    endpoint: "/api/cron/detect-patterns",
    started_at: new Date(started),
    ok,
    counts: {
      users_scanned: usersScanned,
      patterns_upserted: patternsUpserted,
      candidate_users: userIds.length,
    },
    errors: errors.slice(0, 10),
  });
  return json({
    ok,
    users_scanned: usersScanned,
    patterns_upserted: patternsUpserted,
    latency_ms: Date.now() - started,
    errors: errors.length ? errors.slice(0, 10) : undefined,
    ran_at: new Date().toISOString(),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Per-user pattern detection
// ──────────────────────────────────────────────────────────────────────────

interface DetectedPattern {
  pattern_kind: string;
  description: string;
  confidence: number;
  evidence_count: number;
}

async function detectForUser(
  db: ReturnType<typeof getSupabase>,
  anthropic: Anthropic,
  user_id: string,
): Promise<DetectedPattern[]> {
  if (!db) return [];

  // Pull the user's recent events + trips. We include: request events
  // (what the user asked), tool events (what got dispatched), and
  // trip rows (committed compound bookings). Anything else would be
  // noise for pattern detection.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: trips }, sessionRows] = await Promise.all([
    db
      .from("trips")
      .select("trip_id, status, payload, created_at")
      .eq("user_id", user_id)
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("trips")
      .select("session_id")
      .eq("user_id", user_id)
      .gt("created_at", since)
      .limit(500),
  ]);

  const userSessions = Array.from(
    new Set(((sessionRows.data as { session_id?: string }[]) ?? []).map((r) => String(r.session_id ?? "")).filter(Boolean)),
  );

  let events: Array<{ frame_type: string; frame_value: unknown; ts: string }> = [];
  if (userSessions.length > 0) {
    const { data: ev } = await db
      .from("events")
      .select("frame_type, frame_value, ts")
      .in("session_id", userSessions)
      .in("frame_type", ["request", "tool"])
      .order("ts", { ascending: false })
      .limit(MAX_EVENTS_PER_USER);
    events = (ev ?? []) as Array<{ frame_type: string; frame_value: unknown; ts: string }>;
  }

  // Compact the input for Claude. One line per event, trimmed.
  const lines: string[] = [];
  for (const t of trips ?? []) {
    const payload = (t as { payload?: unknown }).payload;
    const title =
      payload && typeof payload === "object" && "trip_title" in payload
        ? String((payload as { trip_title?: unknown }).trip_title ?? "")
        : "";
    lines.push(
      `TRIP ${(t as { created_at?: string }).created_at}  status=${(t as { status?: string }).status}  ${title.slice(0, 80)}`,
    );
  }
  for (const e of events) {
    const when = e.ts;
    if (e.frame_type === "request") {
      const msg =
        e.frame_value && typeof e.frame_value === "object"
          ? String(
              ((e.frame_value as { frame_value?: Record<string, unknown> }).frame_value ??
                (e.frame_value as Record<string, unknown>))["last_user_message"] ?? "",
            )
          : "";
      if (msg) lines.push(`USER  ${when}  ${msg.slice(0, 140)}`);
    } else if (e.frame_type === "tool") {
      const v = e.frame_value as { value?: { name?: string; ok?: boolean } } | undefined;
      const name = v?.value?.name ?? "?";
      const ok = v?.value?.ok === false ? "fail" : "ok";
      lines.push(`TOOL  ${when}  ${name}  ${ok}`);
    }
    if (lines.length > MAX_EVENTS_PER_USER) break;
  }

  if (lines.length < 5) return []; // not enough signal

  const prompt = `You are analyzing a single user's last 30 days of behavior on a personal concierge. List the recurring BEHAVIORAL patterns you see — not one-off actions.

For each pattern, output:
  pattern_kind   one of: day_of_week | time_of_day | frequent_route | frequent_destination | recurring_order | cuisine | budget_range | companion
  description    short, third-person, user-readable. Example: "Orders food on Friday evenings."
  confidence     0..1. Use >= 0.7 only when you see ≥3 examples in the data.
  evidence_count how many times you see the pattern in the data.

Rules:
  - Skip anything with fewer than 3 supporting examples.
  - Do NOT guess the user's identity, relationships, or anything not in the data.
  - Return at most ${MAX_PATTERNS_PER_USER} patterns.
  - Return valid JSON — an array of objects with the four fields above.

DATA:
${lines.join("\n")}

Respond with ONLY the JSON array. No prose, no code fences.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system:
      "You are a careful pattern-detection assistant. Return strictly valid JSON. Never invent evidence.",
    messages: [{ role: "user", content: prompt }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: DetectedPattern[] = [];
  for (const p of parsed.slice(0, MAX_PATTERNS_PER_USER)) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const kind = typeof o.pattern_kind === "string" ? o.pattern_kind : "";
    const desc = typeof o.description === "string" ? o.description.trim() : "";
    const conf = typeof o.confidence === "number" ? o.confidence : 0;
    const ev = typeof o.evidence_count === "number" ? Math.max(1, Math.floor(o.evidence_count)) : 1;
    if (!kind || !desc) continue;
    if (conf < MIN_CONFIDENCE) continue;
    if (!PATTERN_KINDS.has(kind)) continue;
    out.push({ pattern_kind: kind, description: desc, confidence: conf, evidence_count: ev });
  }
  return out;
}

const PATTERN_KINDS = new Set([
  "day_of_week",
  "time_of_day",
  "frequent_route",
  "frequent_destination",
  "recurring_order",
  "cuisine",
  "budget_range",
  "companion",
]);

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Upsert with fuzzy-dedup
// ──────────────────────────────────────────────────────────────────────────

/**
 * Upsert one pattern. Fuzzy-match against existing rows for the same
 * kind; if a close enough description exists, bump evidence_count +
 * last_observed_at. Otherwise insert new.
 */
async function upsertPattern(
  db: ReturnType<typeof getSupabase>,
  user_id: string,
  p: DetectedPattern,
): Promise<boolean> {
  if (!db) return false;

  const { data: existing } = await db
    .from("user_behavior_patterns")
    .select("id, description, evidence_count, confidence")
    .eq("user_id", user_id)
    .eq("pattern_kind", p.pattern_kind)
    .limit(10);

  const normalized = normalize(p.description);
  const match = (existing ?? []).find(
    (r) => levenshteinRatio(normalize((r as { description?: string }).description ?? ""), normalized) >= 0.8,
  );

  const now = new Date().toISOString();

  if (match) {
    const mr = match as { id?: string; evidence_count?: number; confidence?: number };
    const nextEv = (mr.evidence_count ?? 0) + 1;
    // EMA over confidence so a single low-confidence night can't tank a
    // long-observed pattern.
    const blendedConf = 0.7 * (mr.confidence ?? p.confidence) + 0.3 * p.confidence;
    const { error } = await db
      .from("user_behavior_patterns")
      .update({
        evidence_count: nextEv,
        confidence: blendedConf,
        last_observed_at: now,
      })
      .eq("id", mr.id as string);
    return !error;
  }

  const id = `pat_${randomBytes(9).toString("base64url")}`;
  const { error } = await db.from("user_behavior_patterns").insert({
    id,
    user_id,
    pattern_kind: p.pattern_kind,
    description: p.description,
    evidence_count: p.evidence_count,
    confidence: p.confidence,
    first_observed_at: now,
    last_observed_at: now,
  });
  return !error;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function levenshteinRatio(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
