/**
 * User-level first-party app approvals.
 *
 * Session app approvals are the per-chat evidence ledger. This module keeps
 * the longer-lived consent layer for first-party Lumo apps and bootstraps it
 * into a session approval at the start of a new chat turn.
 */

import { getSupabase } from "./db.js";
import {
  connectFirstPartySessionAppApproval,
  type SessionAppApproval,
} from "./session-app-approvals.js";
import {
  firstPartyConnectionProviderForAgentId,
  isFirstPartyAgentId,
  type FirstPartyConnectionProvider,
} from "./session-app-approvals-core.ts";

export interface UserAppApproval {
  user_id: string;
  agent_id: string;
  approved_at: string;
  granted_scopes: string[];
  connection_provider: FirstPartyConnectionProvider | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface UserAppApprovalRow {
  user_id: string;
  agent_id: string;
  approved_at: string;
  granted_scopes: unknown;
  connection_provider: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listActiveUserAppApprovals(
  user_id: string,
): Promise<UserAppApproval[]> {
  const db = getSupabase();
  if (!db || !user_id || user_id === "anon") return [];

  const { data, error } = await db
    .from("user_app_approvals")
    .select(
      "user_id, agent_id, approved_at, granted_scopes, connection_provider, revoked_at, created_at, updated_at",
    )
    .eq("user_id", user_id)
    .is("revoked_at", null)
    .order("approved_at", { ascending: false });

  if (error) {
    console.warn("[user-app-approvals] list active failed:", error.message);
    return [];
  }

  return (data ?? [])
    .map((row) => toUserAppApproval(row as UserAppApprovalRow))
    .filter((approval) => isFirstPartyAgentId(approval.agent_id));
}

export async function bootstrapUserAppApprovalsForSession(
  user_id: string,
  session_id: string,
): Promise<SessionAppApproval[]> {
  const session = session_id.trim();
  if (!session || !user_id || user_id === "anon") return [];

  const approvals = await listActiveUserAppApprovals(user_id);
  if (approvals.length === 0) return [];

  const bootstrapped = await Promise.all(
    approvals.map(async (approval) => {
      const provider =
        approval.connection_provider ??
        firstPartyConnectionProviderForAgentId(approval.agent_id);
      if (!provider) return null;
      try {
        return await connectFirstPartySessionAppApproval({
          user_id,
          session_id: session,
          agent_id: approval.agent_id,
          granted_scopes: approval.granted_scopes,
          connection_provider: provider,
        });
      } catch (err) {
        console.error("[user-app-approvals] bootstrap session approval failed", {
          user_id,
          session_id: session,
          agent_id: approval.agent_id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );

  return bootstrapped.filter(
    (approval): approval is SessionAppApproval => approval !== null,
  );
}

export function mergeSessionAppApprovals(
  existing: SessionAppApproval[],
  bootstrapped: SessionAppApproval[],
): SessionAppApproval[] {
  if (bootstrapped.length === 0) return existing;
  const byKey = new Map<string, SessionAppApproval>();
  for (const approval of existing) {
    byKey.set(`${approval.session_id}:${approval.agent_id}`, approval);
  }
  for (const approval of bootstrapped) {
    byKey.set(`${approval.session_id}:${approval.agent_id}`, approval);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    b.approved_at.localeCompare(a.approved_at),
  );
}

export async function revokeUserAppApproval(
  user_id: string,
  agent_id: string,
): Promise<UserAppApproval | null> {
  const db = getSupabase();
  const agent = agent_id.trim();
  if (!db || !user_id || user_id === "anon" || !isFirstPartyAgentId(agent)) {
    return null;
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("user_app_approvals")
    .update({ revoked_at: now, updated_at: now })
    .eq("user_id", user_id)
    .eq("agent_id", agent)
    .select(
      "user_id, agent_id, approved_at, granted_scopes, connection_provider, revoked_at, created_at, updated_at",
    )
    .maybeSingle();

  if (error) {
    console.warn("[user-app-approvals] revoke failed:", error.message);
    return null;
  }

  await Promise.all([
    db
      .from("agent_connections")
      .update({ status: "revoked", revoked_at: now, updated_at: now })
      .eq("user_id", user_id)
      .eq("agent_id", agent)
      .eq("status", "active"),
    db
      .from("user_agent_installs")
      .update({ status: "revoked", revoked_at: now, updated_at: now })
      .eq("user_id", user_id)
      .eq("agent_id", agent)
      .eq("status", "installed"),
  ]).catch((cleanupError) => {
    console.warn(
      "[user-app-approvals] revoke cleanup failed:",
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    );
  });

  return data ? toUserAppApproval(data as UserAppApprovalRow) : null;
}

function toUserAppApproval(row: UserAppApprovalRow): UserAppApproval {
  return {
    user_id: row.user_id,
    agent_id: row.agent_id,
    approved_at: row.approved_at,
    granted_scopes: Array.isArray(row.granted_scopes)
      ? row.granted_scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    connection_provider: normalizeConnectionProvider(row.connection_provider),
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeConnectionProvider(
  value: string | null,
): FirstPartyConnectionProvider | null {
  if (
    value === "duffel" ||
    value === "booking" ||
    value === "opentable" ||
    value === "doordash"
  ) {
    return value;
  }
  return null;
}
