/**
 * /api/admin/apps — every app the orchestrator could possibly route
 * to, with admin-grade detail.
 *
 * Sources merged into one list:
 *   - Static registry (config/agents.registry.*.json) → first-party
 *     Lumo agents.
 *   - partner_agents (status approved | revoked | rejected) → third
 *     parties via the publisher portal.
 *   - MCP catalog (config/mcp-servers.json) → third-party MCP servers.
 *
 * Each entry carries:
 *   agent_id, display_name, source ("lumo" | "partner" | "mcp"),
 *   status (active | suspended | revoked | pending | …), health_score
 *   (0..1), connect_model, base_url for first-party (null for
 *   partner/mcp where it's looked up from the row), runtime_override
 *   from agent_runtime_overrides (suspended? rate limits?).
 *
 * Read-only. Mutations go through /api/admin/agent-policy
 * (suspend/revoke) and /api/admin/review-queue (approve/reject).
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import { ensureRegistry } from "@/lib/agent-registry";
import { getSupabase } from "@/lib/db";
import { loadMcpCatalog } from "@/lib/mcp/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AppRow {
  agent_id: string;
  display_name: string;
  one_liner: string;
  source: "lumo" | "partner" | "mcp";
  status: string;
  health_score: number | null;
  category: string | null;
  base_url: string | null;
  connect_model: string | null;
  runtime_status: "active" | "suspended" | "revoked" | null;
  publisher_email: string | null;
  manifest_url: string | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  const apps: AppRow[] = [];
  const sb = getSupabase();

  // 1) First-party from the registry. healthyBridge filters to
  //    runnable; we want the FULL list including unhealthy so the
  //    operator can see why something is dark.
  try {
    const reg = await ensureRegistry();
    for (const e of Object.values(reg.agents)) {
      apps.push({
        agent_id: e.manifest.agent_id,
        display_name: e.manifest.display_name,
        one_liner: e.manifest.one_liner,
        source: e.manifest.agent_id.startsWith("partner:") ? "partner" : "lumo",
        status: "registered",
        health_score: e.health_score,
        category: e.manifest.listing?.category ?? null,
        base_url: e.base_url,
        connect_model: e.manifest.connect.model,
        runtime_status: null, // filled in below from overrides
        publisher_email: null,
        manifest_url: null,
      });
    }
  } catch (err) {
    console.warn("[admin/apps] registry load failed:", err);
  }

  // 2) Pending / rejected / revoked partner agents from the DB
  //    (approved ones are already in the registry above).
  if (sb) {
    try {
      const { data, error } = await sb
        .from("partner_agents")
        .select(
          "id, publisher_email, manifest_url, parsed_manifest, status, certification_status",
        )
        .neq("status", "approved");
      if (!error) {
        for (const row of data ?? []) {
          const m = (row as { parsed_manifest?: { agent_id?: string; display_name?: string; one_liner?: string; listing?: { category?: string } } | null }).parsed_manifest ?? null;
          apps.push({
            agent_id: m?.agent_id ?? `partner-row:${(row as { id?: string }).id}`,
            display_name: m?.display_name ?? "Pending submission",
            one_liner: m?.one_liner ?? "",
            source: "partner",
            status: String((row as { status?: string }).status ?? "pending"),
            health_score: null,
            category: m?.listing?.category ?? null,
            base_url: null,
            connect_model: null,
            runtime_status: null,
            publisher_email: String(
              (row as { publisher_email?: string }).publisher_email ?? "",
            ),
            manifest_url: String(
              (row as { manifest_url?: string }).manifest_url ?? "",
            ),
          });
        }
      }
    } catch (err) {
      console.warn("[admin/apps] partner_agents read failed:", err);
    }
  }

  // 3) MCP servers from the static catalog.
  try {
    const catalog = await loadMcpCatalog();
    for (const s of catalog) {
      apps.push({
        agent_id: `mcp:${s.server_id}`,
        display_name: s.display_name,
        one_liner: s.one_liner,
        source: "mcp",
        status: "registered",
        health_score: null,
        category: s.category ?? null,
        base_url: s.url ?? null,
        connect_model: `mcp_${s.auth_model}`,
        runtime_status: null,
        publisher_email: null,
        manifest_url: null,
      });
    }
  } catch (err) {
    console.warn("[admin/apps] mcp catalog failed:", err);
  }

  // 4) Overlay runtime overrides (suspend/revoke from the policy
  //    table) onto the merged list.
  if (sb) {
    try {
      const { data, error } = await sb
        .from("agent_runtime_overrides")
        .select("agent_id, status");
      if (!error) {
        const map = new Map<string, "active" | "suspended" | "revoked">();
        for (const row of data ?? []) {
          const id = String((row as { agent_id?: string }).agent_id ?? "");
          const st = String((row as { status?: string }).status ?? "active");
          if (id) map.set(id, st as "active" | "suspended" | "revoked");
        }
        for (const a of apps) {
          a.runtime_status = map.get(a.agent_id) ?? null;
        }
      }
    } catch (err) {
      console.warn("[admin/apps] runtime overrides read failed:", err);
    }
  }

  return json({ apps });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
