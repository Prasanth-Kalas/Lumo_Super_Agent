/**
 * /api/admin/agent-policy — runtime app-store controls.
 *
 * Admins can suspend/revoke an approved agent immediately and tune per-user
 * call quotas without changing registry config. The router reads these values
 * before every tool dispatch.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import {
  listRuntimeOverrides,
  upsertRuntimeOverride,
} from "@/lib/runtime-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  agent_id?: unknown;
  status?: unknown;
  reason?: unknown;
  max_calls_per_user_per_minute?: unknown;
  max_calls_per_user_per_day?: unknown;
  max_money_calls_per_user_per_day?: unknown;
}

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);
  const overrides = await listRuntimeOverrides();
  return json({ overrides });
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

  const agent_id = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const status = body.status;
  if (!agent_id) return json({ error: "missing_agent_id" }, 400);
  if (status !== "active" && status !== "suspended" && status !== "revoked") {
    return json({ error: "invalid_status" }, 400);
  }

  const override = await upsertRuntimeOverride({
    agent_id,
    status,
    reason: typeof body.reason === "string" ? body.reason.trim() || null : null,
    max_calls_per_user_per_minute: positiveInt(body.max_calls_per_user_per_minute),
    max_calls_per_user_per_day: positiveInt(body.max_calls_per_user_per_day),
    max_money_calls_per_user_per_day: positiveInt(body.max_money_calls_per_user_per_day),
    updated_by: user.email,
  });
  if (!override) return json({ error: "db_unavailable" }, 503);
  return json({ override });
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
