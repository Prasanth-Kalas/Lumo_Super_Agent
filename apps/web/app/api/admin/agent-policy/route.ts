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
  /**
   * Per-agent (cross-user) ceilings. `null` clears an existing cap;
   * a positive number sets one; `undefined` (omitting the key) leaves
   * the prior value untouched.
   */
  max_calls_per_agent_per_minute?: unknown;
  daily_cost_ceiling_usd?: unknown;
  monthly_cost_ceiling_usd?: unknown;
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
    // Pass through the tri-state semantics: null clears, positive
    // sets, undefined leaves alone. parseClearableLimit normalises
    // that without flattening null → undefined.
    max_calls_per_agent_per_minute: parseClearableLimit(
      body.max_calls_per_agent_per_minute,
      "int",
    ),
    daily_cost_ceiling_usd: parseClearableLimit(
      body.daily_cost_ceiling_usd,
      "money",
    ),
    monthly_cost_ceiling_usd: parseClearableLimit(
      body.monthly_cost_ceiling_usd,
      "money",
    ),
    updated_by: user.email,
  });
  if (!override) return json({ error: "db_unavailable" }, 503);
  return json({ override });
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * Parse a per-agent ceiling field that supports tri-state semantics:
 *   - explicit `null` (in JSON) → caller wants to clear the cap
 *   - positive number → set the cap
 *   - missing or invalid → undefined (leave alone)
 *
 * `int` validates whole-number request counts; `money` accepts any
 * positive finite number for dollar amounts.
 */
function parseClearableLimit(
  v: unknown,
  kind: "int" | "money",
): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  if (kind === "int" && !Number.isInteger(v)) return undefined;
  return v;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
