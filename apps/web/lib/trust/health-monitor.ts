import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../db.js";
import { setAgentKillSwitch } from "../permissions.js";
import { enqueueDemotionReview } from "./queue.js";

export interface AgentHealthMonitorResult {
  ok: boolean;
  counts: {
    agents_scanned: number;
    signals_written: number;
    demotion_reviews_enqueued: number;
    auto_kills: number;
  };
  errors: string[];
}

interface VersionRow {
  agent_id: string;
  version: string;
  manifest: Record<string, unknown>;
}

interface CostRow {
  user_id: string;
  status: string;
  total_usd: number;
  cost_usd_total: number;
  created_at: string;
}

interface AuditRow {
  action: string;
  evidence: Record<string, unknown> | null;
  created_at: string;
}

export async function runAgentHealthMonitor(input: {
  limit?: number;
  db?: SupabaseClient | null;
} = {}): Promise<AgentHealthMonitorResult> {
  const db = input.db ?? getSupabase();
  if (!db) {
    return {
      ok: false,
      counts: { agents_scanned: 0, signals_written: 0, demotion_reviews_enqueued: 0, auto_kills: 0 },
      errors: ["db_unavailable"],
    };
  }

  const { data, error } = await db
    .from("marketplace_agent_versions")
    .select("agent_id, version, manifest")
    .not("published_at", "is", null)
    .eq("yanked", false)
    .limit(input.limit ?? 500);
  if (error) {
    return {
      ok: false,
      counts: { agents_scanned: 0, signals_written: 0, demotion_reviews_enqueued: 0, auto_kills: 0 },
      errors: [error.message],
    };
  }

  const versions = (data ?? []) as VersionRow[];
  const counts = { agents_scanned: versions.length, signals_written: 0, demotion_reviews_enqueued: 0, auto_kills: 0 };
  const errors: string[] = [];
  for (const version of versions) {
    try {
      const windows = await Promise.all([
        computeSignal(db, version, "24h", 24 * 60 * 60 * 1000),
        computeSignal(db, version, "7d", 7 * 24 * 60 * 60 * 1000),
        computeSignal(db, version, "30d", 30 * 24 * 60 * 60 * 1000),
      ]);
      const { error: upsertError } = await db
        .from("agent_health_signals")
        .upsert(windows, { onConflict: "agent_id,agent_version,window_label,window_end" });
      if (upsertError) throw upsertError;
      counts.signals_written += windows.length;

      const signal7d = windows.find((w) => w.window_label === "7d");
      const signal30d = windows.find((w) => w.window_label === "30d");
      const signal24h = windows.find((w) => w.window_label === "24h");
      if (signal24h?.severity === "P0") {
        await setAgentKillSwitch({
          switchType: "agent",
          agentId: version.agent_id,
          reason: "trust_monitor_p0_security_signal",
          severity: "critical",
          createdBy: null,
        });
        counts.auto_kills += 1;
      } else if (
        (signal7d?.error_rate ?? 0) > 0.25 ||
        (signal7d?.scope_denied_rate ?? 0) > 0.05 ||
        (signal30d?.security_flag_count ?? 0) >= 3
      ) {
        await enqueueDemotionReview({
          db,
          agentId: version.agent_id,
          version: version.version,
          severity: "P2",
          healthReport: {
            signal_7d: signal7d,
            signal_30d: signal30d,
          },
        });
        counts.demotion_reviews_enqueued += 1;
      }
    } catch (err) {
      errors.push(`${version.agent_id}@${version.version}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok: errors.length === 0, counts, errors };
}

async function computeSignal(
  db: SupabaseClient,
  version: VersionRow,
  windowLabel: "24h" | "7d" | "30d",
  windowMs: number,
) {
  const now = new Date();
  const since = new Date(now.getTime() - windowMs).toISOString();
  const [{ data: costData }, { data: auditData }] = await Promise.all([
    db
      .from("agent_cost_log")
      .select("user_id, status, total_usd, cost_usd_total, created_at")
      .eq("agent_id", version.agent_id)
      .eq("agent_version", version.version)
      .gt("created_at", since),
    db
      .from("agent_action_audit")
      .select("action, evidence, created_at")
      .eq("agent_id", version.agent_id)
      .eq("agent_version", version.version)
      .gt("created_at", since),
  ]);
  const costRows = (costData ?? []) as CostRow[];
  const auditRows = (auditData ?? []) as AuditRow[];
  const invocationCount = costRows.length;
  const errorCount = costRows.filter((row) => row.status === "aborted_error").length;
  const scopeDeniedCount = auditRows.filter((row) => row.action === "scope.denied").length;
  const maxCost = manifestMaxCost(version.manifest);
  const costOutlierCount = maxCost === null
    ? 0
    : costRows.filter((row) => Number(row.total_usd ?? row.cost_usd_total ?? 0) > maxCost).length;
  const securityFlags = auditRows.filter((row) => row.action === "security.flag");
  const p0Flags = securityFlags.filter((row) => row.evidence?.severity === "P0").length;
  const errorRate = ratio(errorCount, invocationCount);
  const scopeDeniedRate = ratio(scopeDeniedCount, Math.max(invocationCount, scopeDeniedCount));
  const costOutlierRate = ratio(costOutlierCount, invocationCount);
  const severity = p0Flags > 0
    ? "P0"
    : errorRate > 0.25 || scopeDeniedRate > 0.05 || securityFlags.length >= 3
      ? "P2"
      : "info";
  return {
    agent_id: version.agent_id,
    agent_version: version.version,
    window_label: windowLabel,
    window_start: since,
    window_end: new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0,
      0,
      0,
    )).toISOString(),
    invocation_count: invocationCount,
    error_count: errorCount,
    scope_denied_count: scopeDeniedCount,
    cost_outlier_count: costOutlierCount,
    security_flag_count: securityFlags.length,
    unique_users: new Set(costRows.map((row) => row.user_id)).size,
    total_cost_usd: costRows.reduce((sum, row) => sum + Number(row.total_usd ?? row.cost_usd_total ?? 0), 0),
    error_rate: errorRate,
    scope_denied_rate: scopeDeniedRate,
    cost_outlier_rate: costOutlierRate,
    severity,
    recommended_action: severity === "P0" ? "auto_kill" : severity === "P2" ? "demotion_review" : "none",
    evidence: { max_cost_usd_per_invocation: maxCost },
  };
}

function ratio(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.min(1, Math.max(0, n / d));
}

function manifestMaxCost(manifest: Record<string, unknown>): number | null {
  const direct = costModelFromRecord(manifest);
  if (direct !== null) return direct;
  const sample = manifest.x_lumo_sample;
  if (sample && typeof sample === "object" && !Array.isArray(sample)) {
    return costModelFromRecord(sample as Record<string, unknown>);
  }
  return null;
}

function costModelFromRecord(record: Record<string, unknown>): number | null {
  const raw = record.cost_model;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>).max_cost_usd_per_invocation;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
