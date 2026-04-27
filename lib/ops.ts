/**
 * Observability helpers.
 *
 * Two roles:
 *   - writer: `recordCronRun()` is called at the tail of every cron
 *     endpoint with a compact summary. Fire-and-forget from the
 *     endpoint's perspective — a logging failure must never flip a
 *     successful run into a failed one.
 *   - reader: the family of summarize* functions powers /ops. These
 *     run server-side with the service-role Supabase client; the API
 *     layer handles admin-allowlist gating.
 *
 * Nothing here writes PII. counts/errors on ops_cron_runs are
 * rule-specific integers and short error strings — no payloads, no
 * addresses, no tokens.
 */

import { randomBytes } from "node:crypto";
import { getSupabase } from "./db.js";

// ──────────────────────────────────────────────────────────────────────────
// Writer
// ──────────────────────────────────────────────────────────────────────────

export interface CronRunSummary {
  endpoint: string;          // "/api/cron/proactive-scan"
  started_at: Date;
  finished_at?: Date;        // defaults to now()
  ok: boolean;
  counts: Record<string, number>; // per-rule totals
  errors?: string[];         // short strings; first 10 only
}

/**
 * Persist one cron-run row. Errors are logged but NOT thrown — the
 * cron's primary work has already happened.
 */
export async function recordCronRun(s: CronRunSummary): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const finished = s.finished_at ?? new Date();
  const latency = Math.max(0, finished.getTime() - s.started_at.getTime());
  const row = {
    id: `run_${randomBytes(9).toString("base64url")}`,
    endpoint: s.endpoint,
    started_at: s.started_at.toISOString(),
    finished_at: finished.toISOString(),
    latency_ms: latency,
    ok: s.ok,
    counts: s.counts ?? {},
    errors: (s.errors ?? []).slice(0, 10),
  };
  const { error } = await db.from("ops_cron_runs").insert(row);
  if (error) {
    console.error("[ops] recordCronRun failed:", error.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Readers — power /ops dashboard
// ──────────────────────────────────────────────────────────────────────────

export interface CronHealthRow {
  endpoint: string;
  last_run_at: string | null;
  last_ok: boolean | null;
  last_latency_ms: number | null;
  last_counts: Record<string, number> | null;
  last_errors: string[] | null;
  runs_24h: number;
  failures_24h: number;
}

const KNOWN_CRONS = [
  "/api/cron/proactive-scan",
  "/api/cron/evaluate-intents",
  "/api/cron/detect-patterns",
  "/api/cron/sync-workspace",
  "/api/cron/publish-due-posts",
  "/api/cron/index-archive",
  "/api/cron/kg-reconcile",
  "/api/cron/execute-mission-steps",
  "/api/cron/rollback-missions",
] as const;

/**
 * One row per known cron endpoint. Always returns the full list even
 * if a cron has never run (nulls for last_*) so the UI renders three
 * cards deterministically.
 */
export async function cronHealth(): Promise<CronHealthRow[]> {
  const db = getSupabase();
  if (!db) return KNOWN_CRONS.map(blankCronRow);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const results: CronHealthRow[] = [];
  for (const ep of KNOWN_CRONS) {
    const { data: lastRow } = await db
      .from("ops_cron_runs")
      .select("finished_at, ok, latency_ms, counts, errors")
      .eq("endpoint", ep)
      .order("finished_at", { ascending: false })
      .limit(1);

    const { count: runsTotal } = await db
      .from("ops_cron_runs")
      .select("*", { count: "exact", head: true })
      .eq("endpoint", ep)
      .gt("finished_at", since24h);

    const { count: runsFailed } = await db
      .from("ops_cron_runs")
      .select("*", { count: "exact", head: true })
      .eq("endpoint", ep)
      .eq("ok", false)
      .gt("finished_at", since24h);

    const last = lastRow?.[0] as
      | {
          finished_at?: string;
          ok?: boolean;
          latency_ms?: number;
          counts?: Record<string, number>;
          errors?: string[];
        }
      | undefined;

    results.push({
      endpoint: ep,
      last_run_at: last?.finished_at ?? null,
      last_ok: last?.ok ?? null,
      last_latency_ms: last?.latency_ms ?? null,
      last_counts: (last?.counts ?? null) as Record<string, number> | null,
      last_errors: (last?.errors ?? null) as string[] | null,
      runs_24h: Number(runsTotal ?? 0),
      failures_24h: Number(runsFailed ?? 0),
    });
  }
  return results;
}

function blankCronRow(endpoint: string): CronHealthRow {
  return {
    endpoint,
    last_run_at: null,
    last_ok: null,
    last_latency_ms: null,
    last_counts: null,
    last_errors: null,
    runs_24h: 0,
    failures_24h: 0,
  };
}

/**
 * Histogram of autonomy-action outcomes over the last 7 days.
 * Useful signals: total volume, committed / failed / rolled_back ratio.
 */
export interface AutonomyStats {
  total_7d: number;
  by_outcome: Record<string, number>;
  total_amount_cents_7d: number;
  distinct_users_7d: number;
}

export async function autonomyStats(): Promise<AutonomyStats> {
  const db = getSupabase();
  if (!db) {
    return { total_7d: 0, by_outcome: {}, total_amount_cents_7d: 0, distinct_users_7d: 0 };
  }
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("autonomous_actions")
    .select("user_id, outcome, amount_cents")
    .gt("fired_at", since);
  const rows = (data ?? []) as Array<{
    user_id: string;
    outcome: string;
    amount_cents: number;
  }>;
  const byOutcome: Record<string, number> = {};
  let total = 0;
  const users = new Set<string>();
  for (const r of rows) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    total += Number(r.amount_cents ?? 0);
    users.add(r.user_id);
  }
  return {
    total_7d: rows.length,
    by_outcome: byOutcome,
    total_amount_cents_7d: total,
    distinct_users_7d: users.size,
  };
}

/**
 * Pattern detector yield. How much signal is the nightly job producing?
 *   - patterns inserted or bumped in the last 7 days (inferred from
 *     last_observed_at)
 *   - unique users with at least one high-confidence pattern
 *   - avg confidence across those rows
 */
export interface PatternStats {
  active_rows_7d: number;
  distinct_users_7d: number;
  avg_confidence: number | null;
}

export async function patternStats(): Promise<PatternStats> {
  const db = getSupabase();
  if (!db) return { active_rows_7d: 0, distinct_users_7d: 0, avg_confidence: null };
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("user_behavior_patterns")
    .select("user_id, confidence")
    .gt("last_observed_at", since);
  const rows = (data ?? []) as Array<{ user_id: string; confidence: number }>;
  if (rows.length === 0) return { active_rows_7d: 0, distinct_users_7d: 0, avg_confidence: null };
  let sum = 0;
  const users = new Set<string>();
  for (const r of rows) {
    sum += Number(r.confidence ?? 0);
    users.add(r.user_id);
  }
  return {
    active_rows_7d: rows.length,
    distinct_users_7d: users.size,
    avg_confidence: sum / rows.length,
  };
}

/**
 * Notification outbox KPIs. Delivery counts, unread backlog, dedup
 * efficiency (we approximate dedup by noting how many deliver calls
 * the partial-unique index probably no-op'd — not tracked exactly,
 * so report proxy metrics).
 */
export interface NotificationStats {
  delivered_24h: number;
  delivered_7d: number;
  unread_live: number;
  by_kind_7d: Record<string, number>;
}

export async function notificationStats(): Promise<NotificationStats> {
  const db = getSupabase();
  if (!db) {
    return { delivered_24h: 0, delivered_7d: 0, unread_live: 0, by_kind_7d: {} };
  }
  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  const [{ count: d24 }, { data: d7Rows }, { count: unread }] = await Promise.all([
    db
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .gt("created_at", since24),
    db.from("notifications").select("kind").gt("created_at", since7),
    db
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .is("read_at", null)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`),
  ]);

  const byKind: Record<string, number> = {};
  for (const r of (d7Rows ?? []) as Array<{ kind: string }>) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  }

  return {
    delivered_24h: Number(d24 ?? 0),
    delivered_7d: ((d7Rows ?? []) as unknown[]).length,
    unread_live: Number(unread ?? 0),
    by_kind_7d: byKind,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Admin gate
// ──────────────────────────────────────────────────────────────────────────

/**
 * Comma-separated allowlist from LUMO_ADMIN_EMAILS. Matching is case-
 * insensitive and trims whitespace. Empty env → NO admins (closed by
 * default — safer than open-by-default).
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.LUMO_ADMIN_EMAILS ?? "";
  const allow = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length === 0) return false;
  return allow.includes(email.trim().toLowerCase());
}
