/**
 * PERM-1 permission gate.
 *
 * This module is the server-side boundary for Phase-4 agents. It owns:
 * - install + grant writes
 * - grant/revoke cache invalidation
 * - scope checks, spending caps, and kill-switch checks
 * - append-only audit writes
 *
 * Runtime checks fail closed when persistence is unavailable. Installing,
 * granting, and audit writes are service-role operations via lib/db.ts.
 */

import { createHash, randomUUID } from "node:crypto";
import { getSupabase } from "./db.js";

export type PermissionCheckStatus = "ALLOWED" | "DENIED";

export type PermissionDeniedReason =
  | "persistence_unavailable"
  | "agent_killed"
  | "agent_not_installed"
  | "reconsent_required"
  | "scope_not_granted"
  | "scope_expired"
  | "specific_to_mismatch"
  | "per_invocation_cap_exceeded"
  | "per_day_cap_exceeded";

export interface PermissionConstraints {
  up_to_per_invocation_usd?: number;
  per_day_usd?: number;
  specific_to?: string;
  [key: string]: unknown;
}

export interface PermissionCheckInput {
  userId: string;
  agentId: string;
  scope: string;
  agentVersion?: string;
  capabilityId?: string | null;
  requestId?: string;
  missionId?: string | null;
  missionStepId?: string | null;
  amountUsd?: number | null;
  target?: string | null;
  systemAgent?: boolean;
  auditDenials?: boolean;
}

export interface PermissionAllowed {
  status: "ALLOWED";
  constraints: PermissionConstraints;
  expiresAt: string | null;
}

export interface PermissionDenied {
  status: "DENIED";
  reason: PermissionDeniedReason;
  message: string;
  detail?: Record<string, unknown>;
}

export type PermissionCheckResult = PermissionAllowed | PermissionDenied;

export interface GrantPermissionInput {
  userId: string;
  agentId: string;
  agentVersion: string;
  grantedScopes: Array<{
    scope: string;
    constraints?: PermissionConstraints;
    expiresAt?: string | null;
    granted?: boolean;
  }>;
  consentTextHash: string;
}

export interface RevokePermissionInput {
  userId: string;
  agentId: string;
  scope?: string;
  deleteData?: boolean;
}

export interface AuditEventInput {
  userId: string;
  agentId: string;
  agentVersion?: string;
  capabilityId?: string | null;
  scopeUsed: string;
  action: string;
  targetResource?: string | null;
  missionId?: string | null;
  missionStepId?: string | null;
  requestId?: string;
  evidence?: Record<string, unknown>;
}

export interface KillSwitchInput {
  switchType: "system" | "agent" | "user" | "user_agent";
  agentId?: string | null;
  userId?: string | null;
  reason: string;
  severity?: "critical" | "high" | "medium" | "low";
  createdBy?: string | null;
}

interface GrantRow {
  scope: string;
  granted: boolean;
  constraints: unknown;
  expires_at: string | null;
}

interface InstallRow {
  state: "installed" | "suspended" | "revoked";
  agent_version: string;
}

interface ScopeCacheEntry {
  expiresAtMs: number;
  install: InstallRow | null;
  grants: GrantRow[];
  killed: boolean;
}

const SCOPE_CACHE_TTL_MS = 5_000;
const scopeCache = new Map<string, ScopeCacheEntry>();

export class PermissionDeniedError extends Error {
  readonly code = "SCOPE_NOT_GRANTED";
  readonly reason: PermissionDeniedReason;
  readonly detail?: Record<string, unknown>;

  constructor(reason: PermissionDeniedReason, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "PermissionDeniedError";
    this.reason = reason;
    this.detail = detail;
  }
}

export async function checkPermission(
  input: PermissionCheckInput,
): Promise<PermissionCheckResult> {
  if (input.systemAgent) {
    const killed = await isAgentKilled(input.agentId, input.userId);
    if (killed) return deny("agent_killed", "Agent is disabled by a kill switch.");
    return { status: "ALLOWED", constraints: {}, expiresAt: null };
  }

  const db = getSupabase();
  if (!db) return deny("persistence_unavailable", "Permission persistence is unavailable.");

  const snapshot = await getPermissionSnapshot(input.userId, input.agentId);
  if (snapshot.killed) {
    const result = deny("agent_killed", "Agent is disabled by a kill switch.");
    await maybeAuditDenial(input, result);
    return result;
  }
  if (!snapshot.install || snapshot.install.state !== "installed") {
    const result = deny("agent_not_installed", "Agent is not installed for this user.");
    await maybeAuditDenial(input, result);
    return result;
  }
  if (input.agentVersion && snapshot.install.agent_version !== input.agentVersion) {
    const result = deny(
      "reconsent_required",
      "This agent changed its permission contract. Re-consent before using it again.",
      {
        installed_version: snapshot.install.agent_version,
        current_version: input.agentVersion,
      },
    );
    await maybeAuditDenial(input, result);
    return result;
  }

  const grant = snapshot.grants.find((g) => g.scope === input.scope);
  if (!grant || grant.granted !== true) {
    const result = deny("scope_not_granted", "Scope is not granted for this agent.");
    await maybeAuditDenial(input, result);
    return result;
  }

  if (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) {
    const result = deny("scope_expired", "Scope grant has expired.");
    await maybeAuditDenial(input, result);
    return result;
  }

  const constraints = normalizeConstraints(grant.constraints);
  const constraintResult = await enforceConstraints(input, constraints);
  if (constraintResult.status === "DENIED") {
    await maybeAuditDenial(input, constraintResult);
    return constraintResult;
  }

  return {
    status: "ALLOWED",
    constraints,
    expiresAt: grant.expires_at,
  };
}

export function assertPermissionAllowed(result: PermissionCheckResult): asserts result is PermissionAllowed {
  if (result.status === "DENIED") {
    throw new PermissionDeniedError(result.reason, result.message, result.detail);
  }
}

export async function grantPermission(input: GrantPermissionInput): Promise<{
  installed: boolean;
  grantedScopes: string[];
}> {
  if (input.grantedScopes.length === 0) {
    throw new Error("grantPermission requires at least one granted scope");
  }
  const db = getSupabase();
  if (!db) throw new Error("permission_persistence_unavailable");

  const now = new Date().toISOString();
  const { error: installError } = await db.from("agent_installs").upsert(
    {
      user_id: input.userId,
      agent_id: input.agentId,
      agent_version: input.agentVersion,
      state: "installed",
      pinned_version: null,
      consent_text_hash: input.consentTextHash,
      revoked_at: null,
      cleanup_after: null,
      updated_at: now,
    },
    { onConflict: "user_id,agent_id" },
  );
  if (installError) throw new Error(`agent_install_failed:${installError.message}`);

  const rows = input.grantedScopes.map((g) => ({
    user_id: input.userId,
    agent_id: input.agentId,
    scope: g.scope,
    granted: g.granted ?? true,
    constraints: g.constraints ?? {},
    expires_at: g.expiresAt ?? null,
    granted_at: now,
    revoked_at: (g.granted ?? true) ? null : now,
    consent_text_hash: input.consentTextHash,
  }));
  const { error: grantError } = await db
    .from("agent_scope_grants")
    .upsert(rows, { onConflict: "user_id,agent_id,scope" });
  if (grantError) throw new Error(`agent_scope_grant_failed:${grantError.message}`);

  invalidatePermissionCache(input.userId, input.agentId);
  await Promise.all(
    rows.map((row) =>
      recordAuditEvent({
        userId: input.userId,
        agentId: input.agentId,
        agentVersion: input.agentVersion,
        scopeUsed: row.scope,
        action: row.granted ? "scope.granted" : "scope.revoked",
        evidence: {
          constraints: row.constraints,
          expires_at: row.expires_at,
          consent_text_hash: input.consentTextHash,
        },
      }),
    ),
  );

  return {
    installed: true,
    grantedScopes: rows.filter((r) => r.granted).map((r) => r.scope),
  };
}

export async function revokePermission(input: RevokePermissionInput): Promise<void> {
  const db = getSupabase();
  if (!db) throw new Error("permission_persistence_unavailable");
  const now = new Date().toISOString();

  if (input.scope) {
    const { error } = await db
      .from("agent_scope_grants")
      .update({ granted: false, revoked_at: now })
      .eq("user_id", input.userId)
      .eq("agent_id", input.agentId)
      .eq("scope", input.scope);
    if (error) throw new Error(`agent_scope_revoke_failed:${error.message}`);
    await recordAuditEvent({
      userId: input.userId,
      agentId: input.agentId,
      scopeUsed: input.scope,
      action: "scope.revoked",
      evidence: { reason: "user_revoked_scope" },
    });
  } else {
    const { error: installError } = await db
      .from("agent_installs")
      .update({
        state: "revoked",
        revoked_at: now,
        cleanup_after: input.deleteData
          ? now
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq("user_id", input.userId)
      .eq("agent_id", input.agentId);
    if (installError) throw new Error(`agent_revoke_failed:${installError.message}`);

    const { error: grantsError } = await db
      .from("agent_scope_grants")
      .update({ granted: false, revoked_at: now })
      .eq("user_id", input.userId)
      .eq("agent_id", input.agentId);
    if (grantsError) throw new Error(`agent_grants_revoke_failed:${grantsError.message}`);

    await db
      .from("mission_steps")
      .update({ status: "failed", error_text: "agent_revoked", finished_at: now })
      .eq("agent_id", input.agentId)
      .in("status", ["pending", "running", "awaiting_confirmation", "ready"]);

    await recordAuditEvent({
      userId: input.userId,
      agentId: input.agentId,
      scopeUsed: "*",
      action: "agent.revoked",
      evidence: { delete_data: input.deleteData === true },
    });
  }

  invalidatePermissionCache(input.userId, input.agentId);
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  const db = getSupabase();
  if (!db) {
    console.warn("[permissions] audit skipped: persistence unavailable", {
      action: input.action,
      agentId: input.agentId,
      scopeUsed: input.scopeUsed,
    });
    return;
  }
  const evidence = input.evidence ?? {};
  const evidence_hash = sha256(stableStringify(evidence));
  const { error } = await db.from("agent_action_audit").insert({
    user_id: input.userId,
    agent_id: input.agentId,
    agent_version: input.agentVersion ?? "unknown",
    capability_id: input.capabilityId ?? null,
    scope_used: input.scopeUsed,
    action: input.action,
    target_resource: input.targetResource ?? null,
    mission_id: input.missionId ?? null,
    mission_step_id: input.missionStepId ?? null,
    request_id: uuidOrRandom(input.requestId),
    evidence_hash,
    evidence,
  });
  if (error) throw new Error(`agent_audit_insert_failed:${error.message}`);
}

export async function setAgentKillSwitch(input: KillSwitchInput): Promise<void> {
  const db = getSupabase();
  if (!db) throw new Error("permission_persistence_unavailable");
  const now = new Date().toISOString();
  const { error } = await db.from("agent_kill_switches").insert({
    switch_type: input.switchType,
    agent_id: input.agentId ?? null,
    user_id: input.userId ?? null,
    active: true,
    reason: input.reason,
    severity: input.severity ?? "medium",
    created_by: input.createdBy ?? null,
  });
  if (error) throw new Error(`agent_kill_switch_failed:${error.message}`);

  if (input.switchType === "agent" && input.agentId) {
    await db
      .from("marketplace_agents")
      .upsert(
        {
          agent_id: input.agentId,
          killed: true,
          kill_reason: input.reason,
          killed_at: now,
          killed_by: input.createdBy ?? null,
          updated_at: now,
        },
        { onConflict: "agent_id" },
      );
  }
  invalidatePermissionCache(input.userId ?? undefined, input.agentId ?? undefined);
}

export async function isAgentKilled(agentId: string, userId?: string | null): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;

  const cacheKey = killCacheKey(userId, agentId);
  const cached = scopeCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) return cached.killed;

  const checks: Array<{
    switch_type: "system" | "agent" | "user" | "user_agent";
    agent_id?: string;
    user_id?: string;
  }> = [
    { switch_type: "system" },
    { switch_type: "agent", agent_id: agentId },
  ];
  if (userId) {
    checks.push({ switch_type: "user", user_id: userId });
    checks.push({ switch_type: "user_agent", agent_id: agentId, user_id: userId });
  }

  let killed = false;
  for (const check of checks) {
    const query = db
      .from("agent_kill_switches")
      .select("id")
      .eq("active", true)
      .eq("switch_type", check.switch_type)
      .limit(1);
    if ("agent_id" in check) query.eq("agent_id", check.agent_id);
    if ("user_id" in check) query.eq("user_id", check.user_id);
    const { data, error } = await query;
    if (error) {
      console.warn("[permissions] kill-switch read failed:", error.message);
      continue;
    }
    if ((data ?? []).length > 0) {
      killed = true;
      break;
    }
  }

  if (!killed) {
    const { data, error } = await db
      .from("marketplace_agents")
      .select("killed")
      .eq("agent_id", agentId)
      .maybeSingle();
    if (!error && data && (data as { killed?: boolean }).killed === true) {
      killed = true;
    }
  }

  scopeCache.set(cacheKey, {
    expiresAtMs: Date.now() + SCOPE_CACHE_TTL_MS,
    install: null,
    grants: [],
    killed,
  });
  return killed;
}

export function invalidatePermissionCache(userId?: string, agentId?: string): void {
  if (!userId && !agentId) {
    scopeCache.clear();
    return;
  }
  for (const key of scopeCache.keys()) {
    if (userId && !key.includes(`user:${userId}:`)) continue;
    if (agentId && !key.includes(`agent:${agentId}:`)) continue;
    scopeCache.delete(key);
  }
}

export async function rollingSpend(args: {
  userId: string;
  agentId: string;
  scope: string;
  hours?: number;
}): Promise<number> {
  const db = getSupabase();
  if (!db) return 0;
  const since = new Date(Date.now() - (args.hours ?? 24) * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("agent_action_audit")
    .select("evidence")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("scope_used", args.scope)
    .eq("action", "financial.transfer")
    .gte("created_at", since);
  if (error) {
    console.warn("[permissions] rolling spend read failed:", error.message);
    return 0;
  }
  return (data ?? []).reduce((sum, row) => {
    const evidence = (row as { evidence?: unknown }).evidence;
    const amount = evidence && typeof evidence === "object"
      ? Number((evidence as Record<string, unknown>).amount_usd ?? 0)
      : 0;
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
}

async function getPermissionSnapshot(userId: string, agentId: string): Promise<ScopeCacheEntry> {
  const key = scopeCacheKey(userId, agentId);
  const cached = scopeCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached;

  const db = getSupabase();
  if (!db) {
    return {
      expiresAtMs: Date.now() + SCOPE_CACHE_TTL_MS,
      install: null,
      grants: [],
      killed: false,
    };
  }
  const [installResult, grantsResult, killed] = await Promise.all([
    db
      .from("agent_installs")
      .select("state, agent_version")
      .eq("user_id", userId)
      .eq("agent_id", agentId)
      .maybeSingle(),
    db
      .from("agent_scope_grants")
      .select("scope, granted, constraints, expires_at")
      .eq("user_id", userId)
      .eq("agent_id", agentId),
    isAgentKilled(agentId, userId),
  ]);

  if (installResult.error) {
    console.warn("[permissions] install read failed:", installResult.error.message);
  }
  if (grantsResult.error) {
    console.warn("[permissions] grants read failed:", grantsResult.error.message);
  }

  const entry: ScopeCacheEntry = {
    expiresAtMs: Date.now() + SCOPE_CACHE_TTL_MS,
    install: installResult.error ? null : ((installResult.data as InstallRow | null) ?? null),
    grants: grantsResult.error ? [] : ((grantsResult.data as GrantRow[] | null) ?? []),
    killed,
  };
  scopeCache.set(key, entry);
  return entry;
}

async function enforceConstraints(
  input: PermissionCheckInput,
  constraints: PermissionConstraints,
): Promise<PermissionCheckResult> {
  if (constraints.specific_to && input.target && constraints.specific_to !== input.target) {
    return deny("specific_to_mismatch", "Target does not match scope qualifier.", {
      expected: constraints.specific_to,
      target: input.target,
    });
  }

  const amountUsd = input.amountUsd ?? null;
  if (amountUsd !== null && constraints.up_to_per_invocation_usd !== undefined) {
    if (amountUsd > constraints.up_to_per_invocation_usd) {
      return deny("per_invocation_cap_exceeded", "Amount exceeds per-invocation cap.", {
        amount_usd: amountUsd,
        cap_usd: constraints.up_to_per_invocation_usd,
      });
    }
  }

  if (amountUsd !== null && constraints.per_day_usd !== undefined) {
    const spent = await rollingSpend({
      userId: input.userId,
      agentId: input.agentId,
      scope: input.scope,
      hours: 24,
    });
    if (spent + amountUsd > constraints.per_day_usd) {
      return deny("per_day_cap_exceeded", "Amount exceeds per-day cap.", {
        amount_usd: amountUsd,
        spent_24h_usd: spent,
        cap_usd: constraints.per_day_usd,
      });
    }
  }

  return { status: "ALLOWED", constraints, expiresAt: null };
}

function normalizeConstraints(value: unknown): PermissionConstraints {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: PermissionConstraints = { ...raw };
  if (raw.up_to_per_invocation_usd !== undefined) {
    const n = Number(raw.up_to_per_invocation_usd);
    if (Number.isFinite(n)) out.up_to_per_invocation_usd = n;
  }
  if (raw.per_day_usd !== undefined) {
    const n = Number(raw.per_day_usd);
    if (Number.isFinite(n)) out.per_day_usd = n;
  }
  if (typeof raw.specific_to === "string") out.specific_to = raw.specific_to;
  return out;
}

async function maybeAuditDenial(
  input: PermissionCheckInput,
  result: PermissionDenied,
): Promise<void> {
  if (input.auditDenials === false) return;
  try {
    await recordAuditEvent({
      userId: input.userId,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      capabilityId: input.capabilityId,
      scopeUsed: input.scope,
      action: "scope.denied",
      missionId: input.missionId,
      missionStepId: input.missionStepId,
      requestId: input.requestId,
      evidence: {
        attempted_scope: input.scope,
        reason: result.reason,
        detail: result.detail ?? {},
      },
    });
  } catch (err) {
    console.warn("[permissions] denial audit failed:", err);
  }
}

function deny(
  reason: PermissionDeniedReason,
  message: string,
  detail?: Record<string, unknown>,
): PermissionDenied {
  return { status: "DENIED", reason, message, detail };
}

function scopeCacheKey(userId: string, agentId: string): string {
  return `scope:user:${userId}:agent:${agentId}`;
}

function killCacheKey(userId: string | null | undefined, agentId: string): string {
  return `kill:user:${userId ?? "*"}:agent:${agentId}`;
}

function uuidOrRandom(value: string | undefined): string {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : randomUUID();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
