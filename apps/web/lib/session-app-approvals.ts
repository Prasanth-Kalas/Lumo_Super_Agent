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
export {
  isFirstPartyLumoApp,
  sessionApprovalIdempotencyKey,
} from "./session-app-approvals-core.ts";

export type SessionConnectionProvider =
  | "lumo_first_party"
  | "oauth"
  | "marketplace";

export interface SessionAppApproval {
  user_id: string;
  session_id: string;
  agent_id: string;
  granted_scopes: string[];
  approved_at: string;
  connected_at: string | null;
  connection_provider: SessionConnectionProvider | null;
}

interface SessionAppApprovalRow {
  user_id: string;
  session_id: string;
  agent_id: string;
  granted_scopes: unknown;
  approved_at: string;
  connected_at: string | null;
  connection_provider: string | null;
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
    .select("user_id, session_id, agent_id, granted_scopes, approved_at, connected_at, connection_provider")
    .eq("user_id", user_id)
    .eq("session_id", session)
    .order("approved_at", { ascending: false });

  if (error) {
    console.warn("[session-app-approvals] list failed:", error.message);
    return [];
  }
  return (data ?? []).map(toApproval);
}

export async function getConnectedSessionAppApproval(
  user_id: string,
  session_id: string,
  agent_id: string,
): Promise<SessionAppApproval | null> {
  const db = getSupabase();
  if (!db) return null;
  const session = session_id.trim();
  const agent = agent_id.trim();
  if (!session || !agent) return null;

  const { data, error } = await db
    .from("session_app_approvals")
    .select("user_id, session_id, agent_id, granted_scopes, approved_at, connected_at, connection_provider")
    .eq("user_id", user_id)
    .eq("session_id", session)
    .eq("agent_id", agent)
    .not("connected_at", "is", null)
    .maybeSingle();

  if (error) {
    console.warn("[session-app-approvals] connected lookup failed:", error.message);
    return null;
  }
  return data ? toApproval(data as SessionAppApprovalRow) : null;
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
    .select("user_id, session_id, agent_id, granted_scopes, approved_at, connected_at, connection_provider")
    .single();

  if (error) {
    console.warn("[session-app-approvals] upsert failed:", error.message);
    return null;
  }
  return toApproval(data as SessionAppApprovalRow);
}

export async function connectFirstPartySessionAppApproval(args: {
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

  const { data, error } = await db.rpc(
    "connect_first_party_session_app_approval",
    {
      p_user_id: args.user_id,
      p_session_id: session,
      p_agent_id: agent,
      p_granted_scopes: Array.from(new Set(args.granted_scopes.filter(Boolean))).sort(),
      p_connection_provider: "lumo_first_party",
    },
  );
  if (error) {
    console.warn("[session-app-approvals] first-party connect failed:", error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row ? toApproval(row as SessionAppApprovalRow) : null;
}

export function connectedAgentIdsFromSessionApprovals(
  approvals: SessionAppApproval[],
): Set<string> {
  return new Set(
    approvals
      .filter((approval) => approval.connected_at !== null)
      .map((approval) => approval.agent_id),
  );
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
    connected_at: row.connected_at ?? null,
    connection_provider: normalizeConnectionProvider(row.connection_provider),
  };
}

function normalizeConnectionProvider(value: string | null): SessionConnectionProvider | null {
  if (
    value === "lumo_first_party" ||
    value === "oauth" ||
    value === "marketplace"
  ) {
    return value;
  }
  return null;
}
