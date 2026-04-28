/**
 * PERM-1 re-consent endpoint.
 *
 * When a manifest version or declared scopes change, active grants pause until
 * the user approves the new contract or pins the previous version.
 */

import type { NextRequest } from "next/server";
import { AuthError, requireServerUser } from "@/lib/auth";
import { ensureRegistry } from "@/lib/agent-registry";
import { getSupabase } from "@/lib/db";
import {
  consentTextForAgent,
  consentTextHash,
  permissionScopesForManifest,
  type PermissionScopeDescriptor,
} from "@/lib/permission-manifest";
import {
  grantPermission,
  recordAuditEvent,
  type PermissionConstraints,
} from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { agent_id: string };
}

interface Body {
  action?: unknown;
  consent_text_hash?: unknown;
  granted_scopes?: unknown;
}

interface GrantRow {
  scope: string;
  constraints: unknown;
  expires_at: string | null;
  granted: boolean;
}

interface ReconsentPlan {
  agent: {
    agent_id: string;
    display_name: string;
    one_liner: string;
    version: string;
  };
  installed_version: string;
  pinned_version: string | null;
  requires_reconsent: boolean;
  current_scopes: PermissionScopeDescriptor[];
  added_scopes: PermissionScopeDescriptor[];
  removed_scopes: GrantRow[];
  unchanged_scopes: PermissionScopeDescriptor[];
  consent_text_hash: string;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const plan = await buildReconsentPlan(auth.userId, ctx.params.agent_id);
  if (!plan.ok) return json({ error: plan.error }, plan.status);
  return json(plan.value);
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const plan = await buildReconsentPlan(auth.userId, ctx.params.agent_id);
  if (!plan.ok) return json({ error: plan.error }, plan.status);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (body.action === "pin_previous") {
    const db = getSupabase();
    if (!db) return json({ error: "db_unavailable" }, 503);
    const { error } = await db
      .from("agent_installs")
      .update({ pinned_version: plan.value.installed_version, updated_at: new Date().toISOString() })
      .eq("user_id", auth.userId)
      .eq("agent_id", plan.value.agent.agent_id);
    if (error) return json({ error: "pin_failed", detail: error.message }, 500);
    await recordAuditEvent({
      userId: auth.userId,
      agentId: plan.value.agent.agent_id,
      agentVersion: plan.value.installed_version,
      scopeUsed: "*",
      action: "agent.version_pinned",
      evidence: { pinned_version: plan.value.installed_version },
    });
    return json({ pinned: true, pinned_version: plan.value.installed_version });
  }

  if (body.action !== "approve") return json({ error: "invalid_action" }, 400);
  if (body.consent_text_hash !== plan.value.consent_text_hash) {
    return json({ error: "consent_text_hash_mismatch" }, 400);
  }

  const requested = normalizeRequestedScopes(body.granted_scopes);
  const currentScopeSet = new Set(plan.value.current_scopes.map((scope) => scope.scope));
  const invalid = requested.find((scope) => !currentScopeSet.has(scope.scope));
  if (invalid) return json({ error: `scope_not_allowed:${invalid.scope}` }, 400);

  const grantedScopes = requested.length > 0
    ? requested
    : plan.value.current_scopes.map((scope) => ({
        scope: scope.scope,
        constraints: scope.defaultConstraints,
        expiresAt: null,
      }));

  const result = await grantPermission({
    userId: auth.userId,
    agentId: plan.value.agent.agent_id,
    agentVersion: plan.value.agent.version,
    consentTextHash: plan.value.consent_text_hash,
    grantedScopes,
  });

  await revokeRemovedScopes(auth.userId, plan.value.agent.agent_id, plan.value.removed_scopes);
  return json({ reconsented: true, granted_scopes: result.grantedScopes });
}

async function buildReconsentPlan(userId: string, agentId: string): Promise<
  | { ok: true; value: ReconsentPlan }
  | { ok: false; error: string; status: number }
> {
  const entry = await findAgent(agentId);
  if (!entry) return { ok: false, error: "unknown_agent", status: 404 };
  const db = getSupabase();
  if (!db) return { ok: false, error: "db_unavailable", status: 503 };

  const [installResult, grantsResult] = await Promise.all([
    db
      .from("agent_installs")
      .select("agent_version, pinned_version")
      .eq("user_id", userId)
      .eq("agent_id", entry.manifest.agent_id)
      .maybeSingle(),
    db
      .from("agent_scope_grants")
      .select("scope, constraints, expires_at, granted")
      .eq("user_id", userId)
      .eq("agent_id", entry.manifest.agent_id),
  ]);
  if (installResult.error) {
    return { ok: false, error: "install_read_failed", status: 500 };
  }
  if (!installResult.data) return { ok: false, error: "not_installed", status: 404 };
  if (grantsResult.error) {
    return { ok: false, error: "grants_read_failed", status: 500 };
  }

  const currentScopes = permissionScopesForManifest(entry.manifest);
  const activeGrants = ((grantsResult.data ?? []) as GrantRow[]).filter((grant) => grant.granted);
  const activeScopeSet = new Set(activeGrants.map((grant) => grant.scope));
  const currentScopeSet = new Set(currentScopes.map((scope) => scope.scope));
  const addedScopes = currentScopes.filter((scope) => !activeScopeSet.has(scope.scope));
  const removedScopes = activeGrants.filter((grant) => !currentScopeSet.has(grant.scope));
  const unchangedScopes = currentScopes.filter((scope) => activeScopeSet.has(scope.scope));
  const consentText = consentTextForAgent(entry.manifest, currentScopes);

  return {
    ok: true,
    value: {
      agent: {
        agent_id: entry.manifest.agent_id,
        display_name: entry.manifest.display_name,
        one_liner: entry.manifest.one_liner,
        version: entry.manifest.version,
      },
      installed_version: String((installResult.data as { agent_version?: string }).agent_version ?? ""),
      pinned_version: (installResult.data as { pinned_version?: string | null }).pinned_version ?? null,
      requires_reconsent:
        String((installResult.data as { agent_version?: string }).agent_version ?? "") !== entry.manifest.version ||
        addedScopes.length > 0 ||
        removedScopes.length > 0,
      current_scopes: currentScopes,
      added_scopes: addedScopes,
      removed_scopes: removedScopes,
      unchanged_scopes: unchangedScopes,
      consent_text_hash: consentTextHash(consentText),
    },
  };
}

async function findAgent(agent_id: string) {
  const registry = await ensureRegistry();
  return (
    Object.values(registry.agents).find((entry) => entry.manifest.agent_id === agent_id) ??
    null
  );
}

async function revokeRemovedScopes(userId: string, agentId: string, rows: unknown): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const scopes = rows
    .map((row) => (row && typeof row === "object" ? (row as { scope?: unknown }).scope : null))
    .filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
  if (scopes.length === 0) return;
  const db = getSupabase();
  if (!db) return;
  await db
    .from("agent_scope_grants")
    .update({ granted: false, revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .in("scope", scopes);
  await Promise.all(scopes.map((scope) =>
    recordAuditEvent({
      userId,
      agentId,
      scopeUsed: scope,
      action: "scope.auto_revoked",
      evidence: { reason: "scope_removed_from_manifest" },
    }),
  ));
}

function normalizeRequestedScopes(value: unknown): Array<{
  scope: string;
  constraints: PermissionConstraints;
  expiresAt: string | null;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const record = row as Record<string, unknown>;
    if (typeof record.scope !== "string" || record.scope.length === 0) return [];
    const constraints =
      record.constraints && typeof record.constraints === "object" && !Array.isArray(record.constraints)
        ? (record.constraints as PermissionConstraints)
        : {};
    return [{
      scope: record.scope,
      constraints,
      expiresAt: typeof record.expires_at === "string" ? record.expires_at : null,
    }];
  });
}

async function requireUser(): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  try {
    const user = await requireServerUser();
    return { ok: true, userId: user.id };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, response: json({ error: err.code, detail: err.message }, 401) };
    }
    throw err;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
