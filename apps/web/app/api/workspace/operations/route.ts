/**
 * GET /api/workspace/operations — backing data for the Operations tab.
 *
 * Returns three lists per user:
 *   - connectors: status grid per connected agent (token health, last
 *     refresh, expiration countdown, retries today)
 *   - audit: recent write actions (audit_log_writes) — last 30 entries
 *     across all platforms
 *   - cache: per-platform cache size + freshest entry timestamp
 *
 * Read-only. Uses service-role Supabase to read across the user's rows.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { ensureRegistry } from "@/lib/agent-registry";

export const runtime = "nodejs";

interface ConnectorRow {
  agent_id: string;
  display_name?: string;
  source?: "oauth" | "system";
  status: "active" | "expired" | "revoked" | "error";
  connected_at: string;
  last_used_at: string | null;
  last_refreshed_at: string | null;
  expires_at: string | null;
  expires_in_seconds: number | null;
  scope_count: number;
}

interface AuditRow {
  id: number;
  agent_id: string;
  action_type: string;
  ok: boolean;
  platform_response_code: number | null;
  content_excerpt: string | null;
  created_at: string;
  origin: string;
  error_text: string | null;
}

interface CacheRow {
  agent_id: string;
  rows: number;
  newest_fetched_at: string | null;
}

interface OpsEnvelope {
  generated_at: string;
  connectors: ConnectorRow[];
  audit: AuditRow[];
  cache: CacheRow[];
}

export async function GET(_req: NextRequest) {
  const user = await getServerUser();
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const registry = await ensureRegistry();
  const systemConnectors: ConnectorRow[] = Object.values(registry.agents)
    .filter((entry) => entry.system === true && entry.health_score >= 0.6)
    .map((entry) => ({
      agent_id: entry.manifest.agent_id,
      display_name: entry.manifest.display_name,
      source: "system" as const,
      status: "active" as const,
      connected_at: new Date(registry.loaded_at).toISOString(),
      last_used_at: null,
      last_refreshed_at: null,
      expires_at: null,
      expires_in_seconds: null,
      scope_count: 1,
    }));

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({
      generated_at: new Date().toISOString(),
      connectors: systemConnectors,
      audit: [],
      cache: [],
    } satisfies OpsEnvelope);
  }

  const now = Date.now();

  // 1) Connector status
  const { data: connRows, error: connErr } = await sb
    .from("agent_connections")
    .select(
      "agent_id, status, connected_at, last_used_at, last_refreshed_at, expires_at, scopes",
    )
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (connErr) {
    console.error("[ops] agent_connections read failed", connErr);
  }

  const connectors: ConnectorRow[] = [
    ...systemConnectors,
    ...(connRows ?? []).map((row) => {
      const expiresAt = row.expires_at as string | null;
      const expiresInSeconds = expiresAt
        ? Math.floor((new Date(expiresAt).getTime() - now) / 1000)
        : null;
      return {
        agent_id: row.agent_id as string,
        source: "oauth" as const,
        status: row.status as ConnectorRow["status"],
        connected_at: row.connected_at as string,
        last_used_at: (row.last_used_at as string | null) ?? null,
        last_refreshed_at: (row.last_refreshed_at as string | null) ?? null,
        expires_at: expiresAt,
        expires_in_seconds: expiresInSeconds,
        scope_count: Array.isArray(row.scopes) ? row.scopes.length : 0,
      };
    }),
  ];

  // 2) Audit log — last 30 across platforms
  const { data: auditRows, error: auditErr } = await sb
    .from("audit_log_writes")
    .select(
      "id, agent_id, action_type, ok, platform_response_code, content_excerpt, created_at, origin, error_text",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(30);

  if (auditErr) {
    console.error("[ops] audit_log_writes read failed", auditErr);
  }

  const audit: AuditRow[] = (auditRows ?? []).map((row) => ({
    id: row.id as number,
    agent_id: row.agent_id as string,
    action_type: row.action_type as string,
    ok: row.ok as boolean,
    platform_response_code: (row.platform_response_code as number | null) ?? null,
    content_excerpt: (row.content_excerpt as string | null) ?? null,
    created_at: row.created_at as string,
    origin: row.origin as string,
    error_text: (row.error_text as string | null) ?? null,
  }));

  // 3) Cache size per platform
  const cache: CacheRow[] = [];
  try {
    const { data: cacheAgg } = await sb
      .from("connector_responses_archive")
      .select("agent_id, fetched_at")
      .eq("user_id", user.id)
      .order("fetched_at", { ascending: false })
      .limit(2000); // crude cap to avoid heavy scans

    const grouped = new Map<string, { rows: number; newest: string | null }>();
    for (const r of (cacheAgg ?? []) as Array<{ agent_id: string; fetched_at: string }>) {
      const cur = grouped.get(r.agent_id) ?? { rows: 0, newest: null };
      cur.rows += 1;
      if (!cur.newest || r.fetched_at > cur.newest) cur.newest = r.fetched_at;
      grouped.set(r.agent_id, cur);
    }
    for (const [agent_id, v] of grouped) {
      cache.push({ agent_id, rows: v.rows, newest_fetched_at: v.newest });
    }
  } catch (err) {
    console.warn("[ops] cache size read soft-failed", err);
  }

  const envelope: OpsEnvelope = {
    generated_at: new Date().toISOString(),
    connectors,
    audit,
    cache,
  };
  return NextResponse.json(envelope);
}
