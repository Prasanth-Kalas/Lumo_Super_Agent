/**
 * Pure helpers for the /admin/intelligence dashboard.
 *
 * No DB, no env, no fetch — only types + functions that take raw rows
 * (or raw upstream JSON) and produce dashboard-shaped data. This keeps
 * the surface unit-testable from a `.test.mjs` file with no Supabase
 * mocks required.
 *
 * The DB-glue and brain-fetch glue live in lib/admin-stats.ts; the
 * route handler in app/api/admin/intelligence/stats/route.ts wires
 * those together behind the LUMO_ADMIN_EMAILS allowlist.
 *
 * Why "intelligence" and not just "stats": the dashboard shows the
 * cron + brain + proactive-moments + anomaly-findings stack — the
 * surface that makes Lumo's intelligence layer observable. /admin
 * already has /apps for orchestrator routing and /health for external
 * monitor links; this is the third leg.
 */

import type { AnomalyFinding as MlAnomalyFinding } from "@lumo/shared-types";

// AnomalyFinding["finding_type"] is the Pydantic literal union from
// apps/ml-service/lumo_ml/schemas.py. Reusing it here narrows the dashboard
// row's `finding_type` from a generic `string` to the canonical set so
// drift in the Pydantic source surfaces as a TS error here.
export type AnomalyFindingType = MlAnomalyFinding["finding_type"];

// ──────────────────────────────────────────────────────────────────────────
// Types — stable shape returned by /api/admin/intelligence/stats
// ──────────────────────────────────────────────────────────────────────────

export interface CronHealthRow {
  endpoint: string;
  last_run_at: string | null;
  ok_count_24h: number;
  fail_count_24h: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
}

export interface BrainToolStats {
  tool_name: string;
  call_count_24h: number;
  ok_rate_24h: number; // 0..1
  latency_p50_ms: number;
  latency_p95_ms: number;
}

export interface ProactiveMomentRow {
  id: string;
  user_id: string;
  moment_type: string;
  urgency: string;
  status: string;
  title: string;
  body_excerpt: string; // first 120 chars of body
  created_at: string;
  age_seconds: number;
}

export interface AnomalyFindingRow {
  id: string;
  user_id: string;
  metric_key: string;
  finding_type: AnomalyFindingType | "unknown";
  actual_value: number;
  expected_value: number | null;
  z_score: number | null;
  confidence: number | null;
  detected_at: string;
  age_seconds: number;
}

export interface MissionRow {
  id: string;
  user_id: string;
  session_id: string | null;
  state: string;
  step_count: number;
  step_status_summary: string;
  intent_excerpt: string;
  created_at: string;
  age_seconds: number;
}

export interface BrainHealthSnapshot {
  status: "ok" | "degraded" | "unreachable";
  service_jwt: "ok" | "missing" | "invalid";
  sandbox: "ok" | "degraded" | "unconfigured";
  modal: "ok" | "degraded" | "unconfigured";
  fetched_at: string;
  age_ms: number;
}

export interface AdminIntelligenceStats {
  generated_at: string;
  cron_health: CronHealthRow[];
  brain_health: BrainHealthSnapshot;
  brain_tool_stats: BrainToolStats[];
  recent_proactive_moments: ProactiveMomentRow[];
  recent_anomaly_findings: AnomalyFindingRow[];
  recent_missions: MissionRow[];
}

// ──────────────────────────────────────────────────────────────────────────
// Cron summarisation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Group raw ops_cron_runs rows by `endpoint`, returning one summary
 * per endpoint with 24h ok/fail counts and p50/p95 latencies.
 *
 * Defensive: rows with non-string endpoints are dropped; latencies
 * that aren't finite numbers are excluded from percentile inputs.
 */
export function summarizeCronRuns(rows: unknown[]): CronHealthRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const byEndpoint = new Map<
    string,
    {
      latencies: number[];
      ok_count: number;
      fail_count: number;
      last_run_at: string | null;
      last_run_ms: number;
    }
  >();

  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const endpoint = typeof row.endpoint === "string" ? row.endpoint : null;
    if (!endpoint) continue;

    let bucket = byEndpoint.get(endpoint);
    if (!bucket) {
      bucket = {
        latencies: [],
        ok_count: 0,
        fail_count: 0,
        last_run_at: null,
        last_run_ms: -Infinity,
      };
      byEndpoint.set(endpoint, bucket);
    }

    const ok = row.ok === true;
    if (ok) bucket.ok_count += 1;
    else bucket.fail_count += 1;

    const latency = Number(row.latency_ms);
    if (Number.isFinite(latency) && latency >= 0) {
      bucket.latencies.push(latency);
    }

    const finishedAt =
      typeof row.finished_at === "string"
        ? row.finished_at
        : typeof row.started_at === "string"
          ? row.started_at
          : null;
    if (finishedAt) {
      const ms = Date.parse(finishedAt);
      if (Number.isFinite(ms) && ms > bucket.last_run_ms) {
        bucket.last_run_ms = ms;
        bucket.last_run_at = finishedAt;
      }
    }
  }

  const out: CronHealthRow[] = [];
  for (const [endpoint, b] of byEndpoint.entries()) {
    out.push({
      endpoint,
      last_run_at: b.last_run_at,
      ok_count_24h: b.ok_count,
      fail_count_24h: b.fail_count,
      latency_p50_ms: percentile(b.latencies, 0.5),
      latency_p95_ms: percentile(b.latencies, 0.95),
    });
  }
  out.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Brain tool usage summarisation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Filter `agent_tool_usage` rows to the brain (`agent_id === "lumo-ml"`)
 * and group by `tool_name`. Returns per-tool call count, ok rate, and
 * p50/p95 latencies over the input window.
 */
export function summarizeBrainToolUsage(rows: unknown[]): BrainToolStats[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const byTool = new Map<
    string,
    { calls: number; oks: number; latencies: number[] }
  >();

  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (row.agent_id !== "lumo-ml") continue;
    const tool = typeof row.tool_name === "string" ? row.tool_name : null;
    if (!tool) continue;

    let bucket = byTool.get(tool);
    if (!bucket) {
      bucket = { calls: 0, oks: 0, latencies: [] };
      byTool.set(tool, bucket);
    }
    bucket.calls += 1;
    if (row.ok === true) bucket.oks += 1;
    const latency = Number(row.latency_ms);
    if (Number.isFinite(latency) && latency >= 0) bucket.latencies.push(latency);
  }

  const out: BrainToolStats[] = [];
  for (const [tool_name, b] of byTool.entries()) {
    out.push({
      tool_name,
      call_count_24h: b.calls,
      ok_rate_24h: b.calls > 0 ? b.oks / b.calls : 0,
      latency_p50_ms: percentile(b.latencies, 0.5) ?? 0,
      latency_p95_ms: percentile(b.latencies, 0.95) ?? 0,
    });
  }
  out.sort((a, b) => b.call_count_24h - a.call_count_24h);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Proactive moment + anomaly finding row formatting
// ──────────────────────────────────────────────────────────────────────────

/**
 * Flatten a proactive_moments row into a UI-shaped record. Truncates
 * `body` to 120 chars (with no ellipsis appended — the UI can decide
 * presentation). Returns null on completely invalid input.
 */
export function formatProactiveMoment(
  row: unknown,
  nowMs: number,
): ProactiveMomentRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const user_id = typeof r.user_id === "string" ? r.user_id : null;
  const created_at = typeof r.created_at === "string" ? r.created_at : null;
  if (!id || !user_id || !created_at) return null;

  const body = typeof r.body === "string" ? r.body : "";
  const created_ms = Date.parse(created_at);
  const age_seconds = Number.isFinite(created_ms)
    ? Math.max(0, Math.floor((nowMs - created_ms) / 1000))
    : 0;

  return {
    id,
    user_id,
    moment_type: typeof r.moment_type === "string" ? r.moment_type : "unknown",
    urgency: typeof r.urgency === "string" ? r.urgency : "medium",
    status: typeof r.status === "string" ? r.status : "pending",
    title: typeof r.title === "string" ? r.title : "",
    body_excerpt: body.slice(0, 120),
    created_at,
    age_seconds,
  };
}

/**
 * Flatten an anomaly_findings row into a UI-shaped record. Returns
 * null on completely invalid input.
 */
export function formatAnomalyFinding(
  row: unknown,
  nowMs: number,
): AnomalyFindingRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const user_id = typeof r.user_id === "string" ? r.user_id : null;
  const detected_at = typeof r.detected_at === "string" ? r.detected_at : null;
  if (!id || !user_id || !detected_at) return null;

  const detected_ms = Date.parse(detected_at);
  const age_seconds = Number.isFinite(detected_ms)
    ? Math.max(0, Math.floor((nowMs - detected_ms) / 1000))
    : 0;

  return {
    id,
    user_id,
    metric_key: typeof r.metric_key === "string" ? r.metric_key : "unknown",
    finding_type: normalizeFindingType(r.finding_type),
    actual_value: Number.isFinite(Number(r.actual_value))
      ? Number(r.actual_value)
      : 0,
    expected_value: Number.isFinite(Number(r.expected_value))
      ? Number(r.expected_value)
      : null,
    z_score: Number.isFinite(Number(r.z_score)) ? Number(r.z_score) : null,
    confidence: Number.isFinite(Number(r.confidence))
      ? Number(r.confidence)
      : null,
    detected_at,
    age_seconds,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Mission row formatting (Sprint 3 observability)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Order in which step statuses are rendered in `step_status_summary`. We
 * keep the ordering stable so the dashboard string is deterministic and
 * easy to scan: terminal-success first, then in-flight, then pending,
 * then terminal-failure-ish buckets last. Anything not in this list is
 * appended in insertion order at the tail.
 */
const STEP_STATUS_ORDER: readonly string[] = [
  "succeeded",
  "running",
  "ready",
  "awaiting_confirmation",
  "pending",
  "skipped",
  "failed",
  "rolled_back",
];

/**
 * Group `mission_steps` rows by their `status` and produce a short human
 * string like `"3 succeeded · 1 ready · 2 pending"`. Buckets follow
 * `STEP_STATUS_ORDER`; unknown statuses appear at the tail.
 *
 * Returns the empty string for an empty / missing input — callers can
 * decide to show "—" or hide the column entirely.
 */
export function summarizeStepStatuses(steps: unknown): string {
  if (!Array.isArray(steps) || steps.length === 0) return "";

  const counts = new Map<string, number>();
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const status = typeof (s as Record<string, unknown>).status === "string"
      ? ((s as Record<string, unknown>).status as string)
      : "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  if (counts.size === 0) return "";

  const parts: string[] = [];
  for (const status of STEP_STATUS_ORDER) {
    const n = counts.get(status);
    if (n && n > 0) {
      parts.push(`${n} ${status}`);
      counts.delete(status);
    }
  }
  // Tail: any unknown statuses, alphabetised so the string is deterministic.
  const tail = Array.from(counts.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [status, n] of tail) {
    parts.push(`${n} ${status}`);
  }
  return parts.join(" · ");
}

/**
 * Flatten a `missions` row (+ its `mission_steps` children) into a
 * UI-shaped dashboard record. Truncates `intent_text` to 80 chars
 * (no ellipsis — the UI decides). Returns null on missing required
 * fields (`id`, `user_id`, `created_at`).
 *
 * `steps` should be the rows for this mission only; the helper does
 * not filter by mission_id itself.
 */
export function formatMissionRow(
  mission: unknown,
  steps: unknown,
  nowMs: number,
): MissionRow | null {
  if (!mission || typeof mission !== "object") return null;
  const m = mission as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : null;
  const user_id = typeof m.user_id === "string" ? m.user_id : null;
  const created_at = typeof m.created_at === "string" ? m.created_at : null;
  if (!id || !user_id || !created_at) return null;

  const stepArr = Array.isArray(steps) ? steps : [];
  const intent_text = typeof m.intent_text === "string" ? m.intent_text : "";
  const created_ms = Date.parse(created_at);
  const age_seconds = Number.isFinite(created_ms)
    ? Math.max(0, Math.floor((nowMs - created_ms) / 1000))
    : 0;

  return {
    id,
    user_id,
    session_id: typeof m.session_id === "string" ? m.session_id : null,
    state: typeof m.state === "string" ? m.state : "unknown",
    step_count: stepArr.length,
    step_status_summary: summarizeStepStatuses(stepArr),
    intent_excerpt: intent_text.slice(0, 80),
    created_at,
    age_seconds,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Brain health interpretation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Translate the brain's `/api/health` JSON into our dashboard shape.
 *
 * Rules:
 *   - `null` healthResponse (network error / timeout / non-2xx) →
 *     status="unreachable", everything "unconfigured".
 *   - top-level `status === "ok"` AND no upstream is "degraded" → "ok".
 *   - any upstream "degraded" or top-level "degraded" → "degraded".
 *   - service_jwt: "ok" if upstream.service_jwt.status === "ok",
 *     "missing" if its last_error mentions LUMO_ML_SERVICE_JWT_SECRET
 *     or the field is absent, "invalid" otherwise.
 */
export function interpretBrainHealth(
  healthResponse: unknown,
  fetched_at: string,
  nowMs: number,
): BrainHealthSnapshot {
  const fetched_ms = Date.parse(fetched_at);
  const age_ms = Number.isFinite(fetched_ms)
    ? Math.max(0, nowMs - fetched_ms)
    : 0;

  if (!healthResponse || typeof healthResponse !== "object") {
    return {
      status: "unreachable",
      service_jwt: "missing",
      sandbox: "unconfigured",
      modal: "unconfigured",
      fetched_at,
      age_ms,
    };
  }

  const resp = healthResponse as Record<string, unknown>;
  const upstream =
    resp.upstream && typeof resp.upstream === "object"
      ? (resp.upstream as Record<string, unknown>)
      : {};

  const topStatus = typeof resp.status === "string" ? resp.status : "unknown";

  const service_jwt = readJwtStatus(upstream.service_jwt);
  const sandbox = readUpstreamStatus(upstream.sandbox);
  const modal = readUpstreamStatus(
    upstream.modal_whisper ?? upstream.modal_clip ?? upstream.modal,
  );

  let status: BrainHealthSnapshot["status"];
  if (topStatus === "ok" && sandbox === "ok" && modal === "ok" && service_jwt === "ok") {
    status = "ok";
  } else {
    status = "degraded";
  }

  return { status, service_jwt, sandbox, modal, fetched_at, age_ms };
}

function readJwtStatus(value: unknown): "ok" | "missing" | "invalid" {
  if (!value || typeof value !== "object") return "missing";
  const v = value as Record<string, unknown>;
  if (v.status === "ok") return "ok";
  const lastError = typeof v.last_error === "string" ? v.last_error : "";
  if (
    !v.status ||
    /not set|missing|unset|LUMO_ML_SERVICE_JWT_SECRET/i.test(lastError)
  ) {
    return "missing";
  }
  return "invalid";
}

function readUpstreamStatus(value: unknown): "ok" | "degraded" | "unconfigured" {
  if (!value || typeof value !== "object") return "unconfigured";
  const v = value as Record<string, unknown>;
  if (v.status === "ok") return "ok";
  const lastError = typeof v.last_error === "string" ? v.last_error : "";
  if (/not set|not configured|missing|unset/i.test(lastError)) {
    return "unconfigured";
  }
  return "degraded";
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const ANOMALY_FINDING_TYPES: readonly AnomalyFindingType[] = [
  "spike",
  "drop",
  "level_shift",
  "pattern_change",
];

function normalizeFindingType(value: unknown): AnomalyFindingType | "unknown" {
  if (typeof value !== "string") return "unknown";
  return (ANOMALY_FINDING_TYPES as readonly string[]).includes(value)
    ? (value as AnomalyFindingType)
    : "unknown";
}

/**
 * Linear-interpolated percentile. Returns null on empty input. Sorts
 * the input copy so callers don't need to pre-sort.
 */
export function percentile(values: number[], p: number): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return Math.round(sorted[lo]! * (1 - frac) + sorted[hi]! * frac);
}
