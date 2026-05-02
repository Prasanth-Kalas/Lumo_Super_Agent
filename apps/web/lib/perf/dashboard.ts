import { getSupabase } from "../db.ts";
import {
  buildAdminPerfDashboardFromRows,
  type AdminPerfDashboard,
  type TimingRow,
} from "./dashboard-core.ts";

export {
  buildAdminPerfDashboardFromRows,
  type AdminPerfDashboard,
  type PerfSlowTurn,
  type PerfStatRow,
  type PerfTrendPoint,
  type TimingRow,
} from "./dashboard-core.ts";

export async function getAdminPerfDashboard(): Promise<AdminPerfDashboard> {
  const generatedAt = new Date().toISOString();
  const supabase = getSupabase();
  if (!supabase) {
    return emptyDashboard(generatedAt);
  }

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [timingResult, planCompareResult] = await Promise.all([
    supabase
      .from("agent_request_timings")
      .select("request_id, phase, bucket, started_at, duration_ms, metadata")
      .gte("started_at", since7d)
      .order("started_at", { ascending: false })
      .limit(20000),
    supabase
      .from("agent_plan_compare")
      .select("agreement_bucket, agreement_step, py_latency_ms, py_error, py_was_stub")
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(20000),
  ]);

  if (timingResult.error || !timingResult.data) {
    console.warn("[perf] dashboard query failed", timingResult.error?.message);
    return buildAdminPerfDashboardFromRows(
      [],
      generatedAt,
      planCompareResult.data ?? [],
    );
  }
  if (planCompareResult.error) {
    console.warn("[perf] plan compare query failed", planCompareResult.error.message);
  }

  return buildAdminPerfDashboardFromRows(
    timingResult.data as TimingRow[],
    generatedAt,
    planCompareResult.data ?? [],
  );
}

function emptyDashboard(generatedAt: string): AdminPerfDashboard {
  return buildAdminPerfDashboardFromRows([], generatedAt, []);
}
