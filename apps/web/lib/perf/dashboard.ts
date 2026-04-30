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
    return {
      generatedAt,
      phaseStats24h: [],
      bucketStats24h: [],
      slowTurns: [],
      totalTrend7d: [],
    };
  }

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("agent_request_timings")
    .select("request_id, phase, bucket, started_at, duration_ms, metadata")
    .gte("started_at", since7d)
    .order("started_at", { ascending: false })
    .limit(20000);

  if (error || !data) {
    console.warn("[perf] dashboard query failed", error?.message);
    return {
      generatedAt,
      phaseStats24h: [],
      bucketStats24h: [],
      slowTurns: [],
      totalTrend7d: [],
    };
  }

  return buildAdminPerfDashboardFromRows(data as TimingRow[], generatedAt);
}
