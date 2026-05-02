import type { AgentManifest } from "@lumo/agent-sdk";
import { ensureRegistry } from "./agent-registry.js";
import {
  permissionSnapshotForManifest,
  upsertAgentInstall,
  type AppInstall,
} from "./app-installs.js";
import { resolvePermissionGate } from "./mission-gate-resolution.ts";
import {
  connectFirstPartySessionAppApproval,
  firstPartyConnectionProviderForApp,
  SessionAppApprovalWriteError,
  upsertSessionAppApproval,
  type SessionAppApproval,
} from "./session-app-approvals.js";
import { sessionApprovalIdempotencyKey } from "./session-app-approvals-core.ts";

export interface MissionInstallApprovalInput {
  user_id: string;
  agent_id: string;
  approval_idempotency_key?: string | null;
  mission_id?: string | null;
  session_id?: string | null;
  original_request?: string | null;
  profile_fields_approved?: unknown;
}

export interface MissionInstallApprovalResult {
  install: AppInstall | null;
  session_approval: SessionAppApproval | null;
  agent: {
    agent_id: string;
    display_name: string;
    connect_model: AgentManifest["connect"]["model"];
  };
}

export class MissionInstallApprovalError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = "MissionInstallApprovalError";
    this.code = code;
    this.status = status;
  }
}

export async function commitMissionInstallApproval(
  input: MissionInstallApprovalInput,
): Promise<MissionInstallApprovalResult> {
  const user_id = input.user_id.trim();
  const agent_id = input.agent_id.trim();
  const session_id = input.session_id?.trim() ?? "";
  const approvalKey = input.approval_idempotency_key?.trim() ?? "";
  if (!user_id || user_id === "anon") {
    throw new MissionInstallApprovalError("not_authenticated", 401);
  }
  if (!agent_id) {
    throw new MissionInstallApprovalError("missing_agent_id", 400);
  }
  if (session_id && approvalKey) {
    const expected = sessionApprovalIdempotencyKey(session_id, agent_id);
    if (approvalKey !== expected) {
      throw new MissionInstallApprovalError("approval_idempotency_key_mismatch", 400);
    }
  }

  const registry = await ensureRegistry();
  const entry =
    Object.values(registry.agents).find(
      (candidate) => candidate.manifest.agent_id === agent_id,
    ) ?? null;
  if (!entry) {
    throw new MissionInstallApprovalError("unknown_agent", 404);
  }

  const manifest = entry.manifest;
  const firstPartyConnectionProvider = firstPartyConnectionProviderForApp(manifest);
  const firstPartyLumoApp = firstPartyConnectionProvider !== null;
  if (manifest.connect.model === "oauth2" && !firstPartyLumoApp) {
    throw new MissionInstallApprovalError(
      "oauth_required",
      409,
      "This app must be connected through OAuth before Lumo can use it.",
    );
  }

  const approvedFields = approvedProfileFields(
    input.profile_fields_approved,
    manifest.pii_scope,
  );
  const permissions = {
    ...permissionSnapshotForManifest(manifest),
    lumo: {
      mission_id: input.mission_id?.trim() || null,
      original_request: input.original_request?.slice(0, 500) ?? null,
      profile_fields_approved: approvedFields,
      approved_at: new Date().toISOString(),
    },
  };

  const install = await upsertAgentInstall({
    user_id,
    agent_id,
    permissions,
    install_source: "lumo",
  });
  const grantedScopes = grantedScopesForApproval(manifest, approvedFields);
  let sessionApproval: SessionAppApproval | null = null;
  if (session_id) {
    try {
      sessionApproval = firstPartyLumoApp
        ? await connectFirstPartySessionAppApproval({
            user_id,
            session_id,
            agent_id,
            granted_scopes: grantedScopes,
            connection_provider: firstPartyConnectionProvider,
          })
        : await upsertSessionAppApproval({
            user_id,
            session_id,
            agent_id,
            granted_scopes: grantedScopes,
          });
    } catch (err) {
      throwApprovalWriteFailed({
        user_id,
        session_id,
        agent_id,
        source:
          err instanceof SessionAppApprovalWriteError
            ? err.context.source
            : firstPartyLumoApp
              ? "connect_first_party_session_app_approval"
              : "upsert_session_app_approval",
        error: err,
      });
    }
    if (!sessionApproval) {
      throwApprovalWriteFailed({
        user_id,
        session_id,
        agent_id,
        source: firstPartyLumoApp
          ? "connect_first_party_session_app_approval_empty_result"
          : "upsert_session_app_approval_empty_result",
        error: new Error("approval write returned no row"),
      });
    }
  }

  await resolvePermissionGate(user_id, agent_id).catch((gateErr) => {
    console.warn("[mission-install-approval] mission permission gate resolution failed", {
      agent_id,
      error: gateErr instanceof Error ? gateErr.message : String(gateErr),
    });
  });

  return {
    install,
    session_approval: sessionApproval,
    agent: {
      agent_id,
      display_name: manifest.display_name,
      connect_model: manifest.connect.model,
    },
  };
}

function grantedScopesForApproval(
  manifest: AgentManifest,
  approvedFields: string[],
): string[] {
  const scopes = new Set<string>();
  if (manifest.connect.model === "oauth2") {
    for (const scope of manifest.connect.scopes) {
      if (scope.required) scopes.add(`oauth:${scope.name}`);
    }
  }
  for (const field of approvedFields) scopes.add(`profile:${field}`);
  if (manifest.requires_payment) scopes.add("payment:confirmation_required");
  return Array.from(scopes).sort();
}

function approvedProfileFields(input: unknown, manifestFields: string[]): string[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(manifestFields);
  return input.filter((field): field is string => {
    return typeof field === "string" && allowed.has(field);
  });
}

function throwApprovalWriteFailed(args: {
  user_id: string;
  session_id: string;
  agent_id: string;
  source: string;
  error: unknown;
}): never {
  const errorMessage =
    args.error instanceof Error ? args.error.message : String(args.error);
  console.error("[mission-install-approval] approval_write_failed", {
    user_id: args.user_id,
    session_id: args.session_id,
    app_id: args.agent_id,
    source: args.source,
    error: errorMessage,
  });
  throw new MissionInstallApprovalError(
    "approval_write_failed",
    503,
    "I couldn't record that app approval. Please try again in a moment.",
  );
}
