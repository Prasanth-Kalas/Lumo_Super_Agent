/**
 * PERM-1 install + consent endpoint.
 *
 * GET returns the server-rendered consent contract and its hash. POST accepts
 * user-selected grants, verifies the hash, and writes durable install/grant
 * rows through the permission library.
 */

import type { NextRequest } from "next/server";
import type { AgentManifest } from "@lumo/agent-sdk";
import { AuthError, getServerUser, requireServerUser } from "@/lib/auth";
import { ensureRegistry } from "@/lib/agent-registry";
import {
  consentTextForAgent,
  consentTextHash,
  permissionScopesForManifest,
  type PermissionScopeDescriptor,
} from "@/lib/permission-manifest";
import {
  grantPermission,
  type PermissionConstraints,
} from "@/lib/permissions";
import {
  permissionSnapshotForManifest,
  upsertAgentInstall,
} from "@/lib/app-installs";
import {
  getAgent as getMarketplaceAgent,
  uninstallAgent,
} from "@/lib/marketplace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { agent_id: string };
}

interface InstallBody {
  agent_version?: unknown;
  consent_text_hash?: unknown;
  granted_scopes?: unknown;
}

interface RequestedScope {
  scope: string;
  constraints?: PermissionConstraints;
  expires_at?: string | null;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const entry = await findAgent(ctx.params.agent_id);
  if (!entry) return json({ error: "unknown_agent" }, 404);
  if (entry.system === true) {
    return json({ error: "system_agent", detail: "System agents are managed by Lumo Core." }, 403);
  }

  const scopes = consentScopes(entry.manifest);
  const consentText = consentTextForAgent(entry.manifest, scopes);
  const user = await getServerUser();
  return json({
    authenticated: !!user,
    agent: {
      agent_id: entry.manifest.agent_id,
      display_name: entry.manifest.display_name,
      one_liner: entry.manifest.one_liner,
      version: entry.manifest.version,
      domain: entry.manifest.domain,
      listing: entry.manifest.listing ?? null,
      connect_model: entry.manifest.connect.model,
      requires_payment: entry.manifest.requires_payment,
    },
    scopes,
    consent_text: consentText,
    consent_text_hash: consentTextHash(consentText),
    default_expires_at: defaultExpiryFor(scopes),
  });
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  let user;
  try {
    user = await requireServerUser();
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: err.code, detail: err.message }, 401);
    }
    throw err;
  }

  const entry = await findAgent(ctx.params.agent_id);
  if (!entry) return json({ error: "unknown_agent" }, 404);
  if (entry.system === true) {
    return json({ error: "system_agent", detail: "System agents are managed by Lumo Core." }, 403);
  }

  const body = await readJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  if (body.agent_version !== entry.manifest.version) {
    return json({ error: "version_mismatch", expected: entry.manifest.version }, 409);
  }

  const scopes = consentScopes(entry.manifest);
  const expectedConsentText = consentTextForAgent(entry.manifest, scopes);
  const expectedHash = consentTextHash(expectedConsentText);
  if (body.consent_text_hash !== expectedHash) {
    return json({ error: "consent_text_hash_mismatch" }, 400);
  }

  const requested = normalizeRequestedScopes(body.granted_scopes);
  const validated = validateRequestedScopes(requested, scopes);
  if (!validated.ok) return json({ error: validated.error }, 400);

  const scopesToGrant = validated.scopes.length > 0
    ? validated.scopes
    : [{ scope: "agent.invoke", constraints: {}, expiresAt: null }];

  const result = await grantPermission({
    userId: user.id,
    agentId: entry.manifest.agent_id,
    agentVersion: entry.manifest.version,
    consentTextHash: expectedHash,
    grantedScopes: scopesToGrant,
  });

  const install = await upsertAgentInstall({
    user_id: user.id,
    agent_id: entry.manifest.agent_id,
    install_source: entry.manifest.connect.model === "oauth2" ? "oauth" : "marketplace",
    permissions: {
      ...permissionSnapshotForManifest(entry.manifest),
      perm_1_granted_scopes: result.grantedScopes,
      perm_1_consent_text_hash: expectedHash,
    },
  });

  return json({
    installed: result.installed,
    granted_scopes: result.grantedScopes,
    install,
  });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  let user;
  try {
    user = await requireServerUser();
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: err.code, detail: err.message }, 401);
    }
    throw err;
  }

  const entry = await findAgent(ctx.params.agent_id);
  if (!entry) return json({ error: "unknown_agent" }, 404);
  if (entry.system === true) {
    return json({ error: "system_agent", detail: "System agents are managed by Lumo Core." }, 403);
  }

  const result = await uninstallAgent({
    userId: user.id,
    agentId: entry.manifest.agent_id,
  });
  return json(result);
}

function consentScopes(manifest: AgentManifest): PermissionScopeDescriptor[] {
  const scopes = permissionScopesForManifest(manifest);
  if (scopes.length > 0) return scopes;
  return [];
}

async function findAgent(agent_id: string) {
  const registry = await ensureRegistry();
  const registryEntry = Object.values(registry.agents).find(
    (entry) => entry.manifest.agent_id === agent_id,
  );
  if (registryEntry) return registryEntry;

  const marketplaceAgent = await getMarketplaceAgent(agent_id);
  if (!marketplaceAgent?.manifest) return null;
  return {
    manifest: {
      ...marketplaceAgent.manifest,
      version: marketplaceAgent.current_version ?? marketplaceAgent.manifest.version,
    },
    health_score: 1,
    system: false,
  };
}

function normalizeRequestedScopes(value: unknown): RequestedScope[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.scope !== "string" || row.scope.length === 0) return [];
    return [{
      scope: row.scope,
      constraints: normalizeConstraints(row.constraints),
      expires_at: typeof row.expires_at === "string" ? row.expires_at : null,
    }];
  });
}

function validateRequestedScopes(
  requested: RequestedScope[],
  allowed: PermissionScopeDescriptor[],
): { ok: true; scopes: Array<{ scope: string; constraints: PermissionConstraints; expiresAt: string | null }> } | {
  ok: false;
  error: string;
} {
  const allowedByScope = new Map(allowed.map((scope) => [scope.scope, scope]));
  const out: Array<{ scope: string; constraints: PermissionConstraints; expiresAt: string | null }> = [];
  for (const requestedScope of requested) {
    const descriptor = allowedByScope.get(requestedScope.scope);
    if (!descriptor) return { ok: false, error: `scope_not_allowed:${requestedScope.scope}` };
    const constraints = clampConstraints(
      requestedScope.constraints ?? {},
      descriptor.defaultConstraints,
    );
    if (!constraints.ok) return { ok: false, error: constraints.error };
    out.push({
      scope: requestedScope.scope,
      constraints: constraints.value,
      expiresAt: requestedScope.expires_at ?? null,
    });
  }
  return { ok: true, scopes: out };
}

function clampConstraints(
  requested: PermissionConstraints,
  defaults: PermissionConstraints,
): { ok: true; value: PermissionConstraints } | { ok: false; error: string } {
  const value: PermissionConstraints = {};
  if (defaults.up_to_per_invocation_usd !== undefined) {
    const requestedCap = Number(
      requested.up_to_per_invocation_usd ?? defaults.up_to_per_invocation_usd,
    );
    if (!Number.isFinite(requestedCap) || requestedCap < 0) {
      return { ok: false, error: "invalid_per_invocation_cap" };
    }
    if (requestedCap > defaults.up_to_per_invocation_usd) {
      return { ok: false, error: "per_invocation_cap_exceeds_manifest" };
    }
    value.up_to_per_invocation_usd = requestedCap;
  }
  if (defaults.per_day_usd !== undefined) {
    const requestedCap = Number(requested.per_day_usd ?? defaults.per_day_usd);
    if (!Number.isFinite(requestedCap) || requestedCap < 0) {
      return { ok: false, error: "invalid_per_day_cap" };
    }
    if (requestedCap > defaults.per_day_usd) {
      return { ok: false, error: "per_day_cap_exceeds_manifest" };
    }
    value.per_day_usd = requestedCap;
  }
  if (defaults.specific_to) {
    const specificTo = typeof requested.specific_to === "string"
      ? requested.specific_to
      : defaults.specific_to;
    if (!specificTo) return { ok: false, error: "missing_specific_to" };
    value.specific_to = specificTo;
  }
  return { ok: true, value };
}

function normalizeConstraints(value: unknown): PermissionConstraints {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as PermissionConstraints;
}

function defaultExpiryFor(scopes: PermissionScopeDescriptor[]): string | null {
  if (scopes.length === 0) return null;
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

async function readJson(req: NextRequest): Promise<InstallBody | null> {
  try {
    return (await req.json()) as InstallBody;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
