/**
 * Per-session app approvals.
 *
 * Global app installs answer "has this user installed this app at all?"
 * This ledger answers "has this chat session already approved this app
 * for this mission flow?" The orchestrator treats active session
 * approvals as ready so a later turn does not re-run the same
 * marketplace approval card.
 */

import { getSupabase } from "./db.js";
export { sessionApprovalIdempotencyKey } from "./session-app-approvals-core.ts";

export interface SessionAppApproval {
  user_id: string;
  session_id: string;
  agent_id: string;
  granted_scopes: string[];
  approved_at: string;
}

interface SessionAppApprovalRow {
  user_id: string;
  session_id: string;
  agent_id: string;
  granted_scopes: unknown;
  approved_at: string;
}

export async function listSessionAppApprovals(
  user_id: string,
  session_id: string,
): Promise<SessionAppApproval[]> {
  const db = getSupabase();
  if (!db) return [];
  const session = session_id.trim();
  if (!session) return [];

  const { data, error } = await db
    .from("session_app_approvals")
    .select("user_id, session_id, agent_id, granted_scopes, approved_at")
    .eq("user_id", user_id)
    .eq("session_id", session)
    .order("approved_at", { ascending: false });

  if (error) {
    console.warn("[session-app-approvals] list failed:", error.message);
    return [];
  }
  return (data ?? []).map(toApproval);
}

export async function upsertSessionAppApproval(args: {
  user_id: string;
  session_id: string;
  agent_id: string;
  granted_scopes: string[];
}): Promise<SessionAppApproval | null> {
  const db = getSupabase();
  if (!db) return null;

  const session = args.session_id.trim();
  const agent = args.agent_id.trim();
  if (!session || !agent) return null;

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("session_app_approvals")
    .upsert(
      {
        user_id: args.user_id,
        session_id: session,
        agent_id: agent,
        granted_scopes: Array.from(new Set(args.granted_scopes.filter(Boolean))).sort(),
        approved_at: now,
      },
      { onConflict: "session_id,agent_id" },
    )
    .select("user_id, session_id, agent_id, granted_scopes, approved_at")
    .single();

  if (error) {
    console.warn("[session-app-approvals] upsert failed:", error.message);
    return null;
  }
  return toApproval(data as SessionAppApprovalRow);
}

function toApproval(row: SessionAppApprovalRow): SessionAppApproval {
  return {
    user_id: row.user_id,
    session_id: row.session_id,
    agent_id: row.agent_id,
    granted_scopes: Array.isArray(row.granted_scopes)
      ? row.granted_scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    approved_at: row.approved_at,
  };
}
