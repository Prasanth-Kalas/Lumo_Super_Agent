/**
 * DB + brain-fetch glue for the /admin/intelligence dashboard.
 *
 * Pulls four signals in parallel:
 *   1. ops_cron_runs — last 24h of recordCronRun() rows
 *   2. agent_tool_usage — last 24h, filtered to agent_id="lumo-ml"
 *   3. proactive_moments — most-recent 20 rows
 *   4. anomaly_findings — most-recent 20 rows
 * Plus an out-of-band call to the brain's /api/health (1s timeout).
 *
 * The shape of the returned envelope is defined in admin-stats-core.ts;
 * all the per-row formatting and percentiles live there. This module
 * is the thin Supabase + fetch wrapper.
 *
 * Auth: this function is unguarded — the route handler in
 * app/api/admin/intelligence/stats/route.ts gates by
 * LUMO_ADMIN_EMAILS. The /admin/intelligence page calls it directly
 * during SSR (already inside the admin layout / middleware).
 */

import { getSupabase } from "./db.js";
import {
  formatAnomalyFinding,
  formatMissionRow,
  formatProactiveMoment,
  interpretBrainHealth,
  summarizeBrainToolUsage,
  summarizeCronRuns,
  type AdminIntelligenceStats,
  type AnomalyFindingRow,
  type BrainHealthSnapshot,
  type BrainToolStats,
  type CronHealthRow,
  type MissionRow,
  type ProactiveMomentRow,
} from "./admin-stats-core.js";

const BRAIN_HEALTH_TIMEOUT_MS = 1000;

export type {
  AdminIntelligenceStats,
  AnomalyFindingRow,
  BrainHealthSnapshot,
  BrainToolStats,
  CronHealthRow,
  MissionRow,
  ProactiveMomentRow,
};

/**
 * Fetch the full /admin/intelligence dashboard payload. Resilient to
 * Supabase being absent (returns empty arrays) and to the brain being
 * unreachable (returns status="unreachable").
 */
export async function fetchAdminIntelligenceStats(opts?: {
  fetchImpl?: typeof fetch;
}): Promise<AdminIntelligenceStats> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const generated_at = new Date().toISOString();
  const nowMs = Date.now();
  const since24h = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  const sb = getSupabase();

  const [
    cron_health,
    brain_tool_stats,
    recent_proactive_moments,
    recent_anomaly_findings,
    recent_missions,
    brain_health,
  ] = await Promise.all([
    fetchCronHealth(sb, since24h),
    fetchBrainToolStats(sb, since24h),
    fetchRecentProactiveMoments(sb, nowMs),
    fetchRecentAnomalyFindings(sb, nowMs),
    fetchRecentMissions(sb, nowMs),
    fetchBrainHealth(fetchImpl, nowMs),
  ]);

  return {
    generated_at,
    cron_health,
    brain_health,
    brain_tool_stats,
    recent_proactive_moments,
    recent_anomaly_findings,
    recent_missions,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Internal — Supabase reads
// ──────────────────────────────────────────────────────────────────────────

async function fetchCronHealth(
  sb: ReturnType<typeof getSupabase>,
  since: string,
): Promise<CronHealthRow[]> {
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("ops_cron_runs")
      .select("endpoint, finished_at, started_at, ok, latency_ms")
      .gt("finished_at", since)
      .limit(2000);
    if (error) {
      console.warn("[admin-stats] ops_cron_runs read failed:", error.message);
      return [];
    }
    return summarizeCronRuns(data ?? []);
  } catch (err) {
    console.warn("[admin-stats] ops_cron_runs read threw:", errString(err));
    return [];
  }
}

async function fetchBrainToolStats(
  sb: ReturnType<typeof getSupabase>,
  since: string,
): Promise<BrainToolStats[]> {
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("agent_tool_usage")
      .select("agent_id, tool_name, ok, latency_ms")
      .eq("agent_id", "lumo-ml")
      .gt("created_at", since)
      .limit(5000);
    if (error) {
      console.warn(
        "[admin-stats] agent_tool_usage read failed:",
        error.message,
      );
      return [];
    }
    return summarizeBrainToolUsage(data ?? []);
  } catch (err) {
    console.warn("[admin-stats] agent_tool_usage read threw:", errString(err));
    return [];
  }
}

async function fetchRecentProactiveMoments(
  sb: ReturnType<typeof getSupabase>,
  nowMs: number,
): Promise<ProactiveMomentRow[]> {
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("proactive_moments")
      .select(
        "id, user_id, moment_type, urgency, status, title, body, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      console.warn(
        "[admin-stats] proactive_moments read failed:",
        error.message,
      );
      return [];
    }
    const rows = (data ?? [])
      .map((r) => formatProactiveMoment(r, nowMs))
      .filter((r): r is ProactiveMomentRow => r !== null);
    return rows;
  } catch (err) {
    console.warn(
      "[admin-stats] proactive_moments read threw:",
      errString(err),
    );
    return [];
  }
}

async function fetchRecentAnomalyFindings(
  sb: ReturnType<typeof getSupabase>,
  nowMs: number,
): Promise<AnomalyFindingRow[]> {
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("anomaly_findings")
      .select(
        "id, user_id, metric_key, finding_type, actual_value, expected_value, z_score, confidence, detected_at",
      )
      .order("detected_at", { ascending: false })
      .limit(20);
    if (error) {
      console.warn(
        "[admin-stats] anomaly_findings read failed:",
        error.message,
      );
      return [];
    }
    const rows = (data ?? [])
      .map((r) => formatAnomalyFinding(r, nowMs))
      .filter((r): r is AnomalyFindingRow => r !== null);
    return rows;
  } catch (err) {
    console.warn(
      "[admin-stats] anomaly_findings read threw:",
      errString(err),
    );
    return [];
  }
}

async function fetchRecentMissions(
  sb: ReturnType<typeof getSupabase>,
  nowMs: number,
): Promise<MissionRow[]> {
  if (!sb) return [];
  try {
    // Pull the 20 most recently-touched missions plus their steps. We do
    // a second query for steps rather than a Supabase nested-select so
    // the surface stays portable across PostgREST versions and easy to
    // mock in tests. 20 missions × ~10 steps each is fine for one round
    // trip.
    const { data: missionRows, error: missionErr } = await sb
      .from("missions")
      .select("id, user_id, session_id, state, intent_text, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(20);
    if (missionErr) {
      console.warn("[admin-stats] missions read failed:", missionErr.message);
      return [];
    }
    const missions = missionRows ?? [];
    if (missions.length === 0) return [];

    const ids = missions
      .map((m) => (typeof m?.id === "string" ? m.id : null))
      .filter((id): id is string => !!id);

    type StepRow = { mission_id?: string | null; status?: string | null };
    let steps: StepRow[] = [];
    if (ids.length > 0) {
      const { data: stepRows, error: stepErr } = await sb
        .from("mission_steps")
        .select("mission_id, status")
        .in("mission_id", ids);
      if (stepErr) {
        console.warn(
          "[admin-stats] mission_steps read failed:",
          stepErr.message,
        );
      } else {
        steps = (stepRows ?? []) as StepRow[];
      }
    }

    const stepsByMission = new Map<string, StepRow[]>();
    for (const s of steps) {
      const mid = typeof s?.mission_id === "string" ? s.mission_id : null;
      if (!mid) continue;
      let bucket = stepsByMission.get(mid);
      if (!bucket) {
        bucket = [];
        stepsByMission.set(mid, bucket);
      }
      bucket.push(s);
    }

    const out: MissionRow[] = [];
    for (const m of missions) {
      const id = typeof (m as { id?: unknown })?.id === "string"
        ? ((m as { id: string }).id)
        : null;
      const formatted = formatMissionRow(
        m,
        id ? (stepsByMission.get(id) ?? []) : [],
        nowMs,
      );
      if (formatted) out.push(formatted);
    }
    return out;
  } catch (err) {
    console.warn("[admin-stats] missions read threw:", errString(err));
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Internal — brain /api/health probe
// ──────────────────────────────────────────────────────────────────────────

async function fetchBrainHealth(
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<BrainHealthSnapshot> {
  const fetched_at = new Date(nowMs).toISOString();
  const baseUrl = resolveBrainBaseUrl();
  if (!baseUrl) {
    return interpretBrainHealth(null, fetched_at, nowMs);
  }
  const url = `${baseUrl}/api/health`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRAIN_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      return interpretBrainHealth(null, fetched_at, nowMs);
    }
    const body = (await res.json().catch(() => null)) as unknown;
    return interpretBrainHealth(body, fetched_at, nowMs);
  } catch {
    return interpretBrainHealth(null, fetched_at, nowMs);
  } finally {
    clearTimeout(timer);
  }
}

function resolveBrainBaseUrl(): string {
  return (
    process.env.LUMO_ML_AGENT_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:3010" : "")
  ).replace(/\/+$/, "");
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
