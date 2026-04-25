/**
 * /api/workspace/accounts — list & switch the user's sub-accounts.
 *
 * GET — returns every connected_accounts row (across all platforms)
 *       so the /workspace header can render a multi-channel selector.
 *
 * POST { agent_id, external_account_id } — sets is_workspace_default=true
 *       on the targeted row and clears the flag on others under the
 *       same (user_id, agent_id). Used when the user picks a different
 *       channel/page from the selector.
 *
 * Per Q2 (PRD): multi-account here means multiple sub-accounts under
 * ONE user's OAuth grant (e.g., 3 YouTube channels managed by one
 * Google account; 5 FB Pages under one user). True multi-tenant
 * (agency view) is V2.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";

export const runtime = "nodejs";

interface AccountRow {
  id: string;
  agent_id: string;
  external_account_id: string;
  display_name: string;
  avatar_url: string | null;
  account_type: string;
  metadata: Record<string, unknown>;
  is_workspace_default: boolean;
  last_seen_at: string;
}

export async function GET(_req: NextRequest) {
  const user = await getServerUser();
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ accounts: [] });
  }
  const { data, error } = await sb
    .from("connected_accounts")
    .select(
      "id, agent_id, external_account_id, display_name, avatar_url, account_type, metadata, is_workspace_default, last_seen_at",
    )
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("last_seen_at", { ascending: false });
  if (error) {
    console.error("[accounts] list failed", error);
    return NextResponse.json({ error: "list failed" }, { status: 500 });
  }
  return NextResponse.json({ accounts: (data ?? []) as AccountRow[] });
}

interface SwitchPayload {
  agent_id?: string;
  external_account_id?: string;
}

export async function POST(req: NextRequest) {
  const user = await getServerUser();
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: SwitchPayload;
  try {
    body = (await req.json()) as SwitchPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.agent_id || !body.external_account_id) {
    return NextResponse.json(
      { error: "agent_id and external_account_id required" },
      { status: 400 },
    );
  }
  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ ok: true, persisted: false });
  }

  // Two-phase update because there's a partial unique index on
  // (user_id, agent_id) WHERE is_workspace_default=true: clear all
  // first, then set the target.
  const { error: clearErr } = await sb
    .from("connected_accounts")
    .update({ is_workspace_default: false })
    .eq("user_id", user.id)
    .eq("agent_id", body.agent_id);

  if (clearErr) {
    console.error("[accounts] clear default failed", clearErr);
    return NextResponse.json({ error: "switch failed" }, { status: 500 });
  }

  const { error: setErr } = await sb
    .from("connected_accounts")
    .update({ is_workspace_default: true })
    .eq("user_id", user.id)
    .eq("agent_id", body.agent_id)
    .eq("external_account_id", body.external_account_id);

  if (setErr) {
    console.error("[accounts] set default failed", setErr);
    return NextResponse.json({ error: "switch failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
