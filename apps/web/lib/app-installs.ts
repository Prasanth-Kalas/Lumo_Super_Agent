/**
 * App installs.
 *
 * OAuth connections prove a user has connected an app, but the app-store model
 * also needs explicit install state for public/no-auth agents. This module is
 * intentionally metadata-only: no downstream provider tokens live here.
 */

import type { AgentManifest } from "@lumo/agent-sdk";
import { getSupabase } from "./db.js";

export type AppInstallStatus = "installed" | "suspended" | "revoked";
export type AppInstallSource =
  | "marketplace"
  | "oauth"
  | "admin"
  | "migration"
  | "lumo";

export interface AppInstall {
  user_id: string;
  agent_id: string;
  status: AppInstallStatus;
  permissions: Record<string, unknown>;
  install_source: AppInstallSource;
  installed_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  updated_at: string;
}

interface InstallRow {
  user_id: string;
  agent_id: string;
  status: AppInstallStatus;
  permissions: unknown;
  install_source: AppInstallSource;
  installed_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  updated_at: string;
}

export function permissionSnapshotForManifest(
  manifest: AgentManifest,
): Record<string, unknown> {
  const connect = manifest.connect;
  return {
    manifest_version: manifest.version,
    connect_model: connect.model,
    required_scopes:
      connect.model === "oauth2"
        ? connect.scopes.filter((s) => s.required).map((s) => s.name)
        : [],
    pii_scope: manifest.pii_scope,
    requires_payment: manifest.requires_payment,
    supported_regions: manifest.supported_regions,
    captured_at: new Date().toISOString(),
  };
}

export async function listInstalledAgentsForUser(
  user_id: string,
): Promise<AppInstall[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("user_agent_installs")
    .select(
      "user_id, agent_id, status, permissions, install_source, installed_at, revoked_at, last_used_at, updated_at",
    )
    .eq("user_id", user_id)
    .order("updated_at", { ascending: false });
  if (error) {
    console.warn("[app-installs] list failed:", error.message);
    return [];
  }
  return (data ?? []).map(toInstall);
}

export async function getInstallForUser(
  user_id: string,
  agent_id: string,
): Promise<AppInstall | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("user_agent_installs")
    .select(
      "user_id, agent_id, status, permissions, install_source, installed_at, revoked_at, last_used_at, updated_at",
    )
    .eq("user_id", user_id)
    .eq("agent_id", agent_id)
    .maybeSingle();
  if (error) {
    console.warn("[app-installs] get failed:", error.message);
    return null;
  }
  return data ? toInstall(data as InstallRow) : null;
}

export async function upsertAgentInstall(args: {
  user_id: string;
  agent_id: string;
  permissions: Record<string, unknown>;
  install_source: AppInstallSource;
}): Promise<AppInstall | null> {
  const db = getSupabase();
  if (!db) return null;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("user_agent_installs")
    .upsert(
      {
        user_id: args.user_id,
        agent_id: args.agent_id,
        status: "installed",
        permissions: args.permissions,
        install_source: args.install_source,
        revoked_at: null,
        updated_at: now,
      },
      { onConflict: "user_id,agent_id" },
    )
    .select(
      "user_id, agent_id, status, permissions, install_source, installed_at, revoked_at, last_used_at, updated_at",
    )
    .single();
  if (error) {
    console.warn("[app-installs] upsert failed:", error.message);
    return null;
  }
  return toInstall(data as InstallRow);
}

export async function revokeAgentInstall(
  user_id: string,
  agent_id: string,
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const now = new Date().toISOString();
  const { error } = await db
    .from("user_agent_installs")
    .update({ status: "revoked", revoked_at: now, updated_at: now })
    .eq("user_id", user_id)
    .eq("agent_id", agent_id);
  if (error) {
    console.warn("[app-installs] revoke failed:", error.message);
  }
}

export async function touchAgentInstallLastUsed(
  user_id: string,
  agent_id: string,
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db
    .from("user_agent_installs")
    .update({ last_used_at: new Date().toISOString() })
    .eq("user_id", user_id)
    .eq("agent_id", agent_id)
    .eq("status", "installed");
}

function toInstall(row: InstallRow): AppInstall {
  return {
    user_id: row.user_id,
    agent_id: row.agent_id,
    status: row.status,
    permissions:
      row.permissions && typeof row.permissions === "object" && !Array.isArray(row.permissions)
        ? (row.permissions as Record<string, unknown>)
        : {},
    install_source: row.install_source,
    installed_at: row.installed_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    updated_at: row.updated_at,
  };
}
