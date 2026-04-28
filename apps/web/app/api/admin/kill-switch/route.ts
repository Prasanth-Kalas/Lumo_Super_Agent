/**
 * PERM-1 kill switch API.
 *
 * Admin-only emergency brake for agent dispatch. The router reads the
 * underlying kill-switch table on every permission decision through a short
 * cache, so new switches propagate without a deploy.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isAdmin } from "@/lib/publisher/access";
import { setAgentKillSwitch, type KillSwitchInput } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  switch_type?: unknown;
  agent_id?: unknown;
  user_id?: unknown;
  reason?: unknown;
  severity?: unknown;
}

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  const db = getSupabase();
  if (!db) return json({ switches: [], warning: "db_unavailable" }, 200);
  const { data, error } = await db
    .from("agent_kill_switches")
    .select("id, switch_type, agent_id, user_id, active, reason, severity, created_by, created_at")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return json({ error: "kill_switch_read_failed", detail: error.message }, 500);
  return json({ switches: data ?? [] });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const parsed = parseKillSwitchBody(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  await setAgentKillSwitch({
    ...parsed.value,
    createdBy: user.email ?? user.id,
  });

  return json({
    killed: true,
    switch_type: parsed.value.switchType,
    agent_id: parsed.value.agentId ?? null,
    user_id: parsed.value.userId ?? null,
    propagation_eta_seconds: 5,
  });
}

function parseKillSwitchBody(body: Body): { ok: true; value: KillSwitchInput } | {
  ok: false;
  error: string;
} {
  const switchType = body.switch_type;
  if (
    switchType !== "system" &&
    switchType !== "agent" &&
    switchType !== "user" &&
    switchType !== "user_agent"
  ) {
    return { ok: false, error: "invalid_switch_type" };
  }

  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if ((switchType === "agent" || switchType === "user_agent") && !agentId) {
    return { ok: false, error: "missing_agent_id" };
  }
  if ((switchType === "user" || switchType === "user_agent") && !userId) {
    return { ok: false, error: "missing_user_id" };
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return { ok: false, error: "missing_reason" };

  const severity = body.severity;
  if (
    severity !== undefined &&
    severity !== "critical" &&
    severity !== "high" &&
    severity !== "medium" &&
    severity !== "low"
  ) {
    return { ok: false, error: "invalid_severity" };
  }

  return {
    ok: true,
    value: {
      switchType,
      agentId: agentId || null,
      userId: userId || null,
      reason,
      severity: severity ?? "high",
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
