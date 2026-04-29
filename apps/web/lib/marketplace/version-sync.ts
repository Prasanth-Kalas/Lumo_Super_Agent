/**
 * MARKETPLACE-1 version yank + patch propagation.
 *
 * Patch updates are auto-installed. Yanked versions are migrated to the
 * nearest non-yanked patch within the same minor version; if no fallback
 * exists the install is suspended. The cron writes marketplace_install_metrics
 * rows because agent_action_audit is user-action oriented and requires a
 * mission/user scope.
 */

import { getSupabase } from "../db.js";
import { recordInstallMetric } from "../marketplace.js";
import {
  latestPatchFromRows,
  nearestPatchFromRows,
  type MarketplaceVersionRowLite,
} from "./version-policy.js";

export interface YankAgentVersionInput {
  agentId: string;
  version: string;
  reason: string;
  yankedBy?: string | null;
}

export interface YankAgentVersionResult {
  agent_id: string;
  version: string;
  fallback_version: string | null;
  impacted_installs: number;
}

export interface MarketplaceVersionSyncResult {
  ok: boolean;
  counts: {
    scanned: number;
    patch_updated: number;
    yank_migrated: number;
    suspended: number;
    errors: number;
  };
  errors: string[];
}

interface InstallRow {
  user_id: string;
  agent_id: string;
  agent_version: string;
}

type VersionRow = MarketplaceVersionRowLite;

export async function yankAgentVersion(
  input: YankAgentVersionInput,
): Promise<YankAgentVersionResult> {
  const db = getSupabase();
  if (!db) throw new Error("marketplace_persistence_unavailable");
  const now = new Date().toISOString();
  const fallback = await nearestNonYankedPatch(input.agentId, input.version);

  const { error: versionError } = await db
    .from("marketplace_agent_versions")
    .update({
      yanked: true,
      yanked_reason: input.reason,
      yanked_at: now,
      yanked_by: input.yankedBy ?? null,
      updated_at: now,
    })
    .eq("agent_id", input.agentId)
    .eq("version", input.version);
  if (versionError) throw new Error(`version_yank_failed:${versionError.message}`);

  const impacted = await impactedInstallCount(input.agentId, input.version);
  const { error: yankedError } = await db.from("marketplace_yanked_versions").upsert(
    {
      agent_id: input.agentId,
      version: input.version,
      yanked_reason: input.reason,
      yanked_by: input.yankedBy ?? null,
      yanked_at: now,
      fallback_version: fallback,
      migration_state: "pending",
      migrated_count: 0,
      blocked_count: 0,
      completed_at: null,
      updated_at: now,
    },
    { onConflict: "agent_id,version" },
  );
  if (yankedError) throw new Error(`yank_queue_failed:${yankedError.message}`);

  const { data: currentAgent } = await db
    .from("marketplace_agents")
    .select("current_version")
    .eq("agent_id", input.agentId)
    .maybeSingle();
  if ((currentAgent as { current_version?: string } | null)?.current_version === input.version) {
    if (fallback) {
      const { data: fallbackVersion } = await db
        .from("marketplace_agent_versions")
        .select("manifest, bundle_path, bundle_sha256, published_at")
        .eq("agent_id", input.agentId)
        .eq("version", fallback)
        .maybeSingle();
      await db
        .from("marketplace_agents")
        .update({
          current_version: fallback,
          state: "published",
          manifest: (fallbackVersion as { manifest?: unknown } | null)?.manifest ?? undefined,
          bundle_path: (fallbackVersion as { bundle_path?: string } | null)?.bundle_path ?? undefined,
          bundle_sha256: (fallbackVersion as { bundle_sha256?: string } | null)?.bundle_sha256 ?? undefined,
          published_at: (fallbackVersion as { published_at?: string | null } | null)?.published_at ?? undefined,
          updated_at: now,
        })
        .eq("agent_id", input.agentId);
    } else {
      await db
        .from("marketplace_agents")
        .update({ state: "yanked", updated_at: now })
        .eq("agent_id", input.agentId);
    }
  }

  return {
    agent_id: input.agentId,
    version: input.version,
    fallback_version: fallback,
    impacted_installs: impacted,
  };
}

export async function runMarketplaceVersionSync(args: {
  limit?: number;
} = {}): Promise<MarketplaceVersionSyncResult> {
  const db = getSupabase();
  if (!db) {
    return {
      ok: false,
      counts: { scanned: 0, patch_updated: 0, yank_migrated: 0, suspended: 0, errors: 1 },
      errors: ["marketplace_persistence_unavailable"],
    };
  }

  const limit = Math.max(1, Math.min(500, Math.trunc(args.limit ?? 200)));
  const { data, error } = await db
    .from("agent_installs")
    .select("user_id, agent_id, agent_version")
    .eq("state", "installed")
    .limit(limit);
  if (error) {
    return {
      ok: false,
      counts: { scanned: 0, patch_updated: 0, yank_migrated: 0, suspended: 0, errors: 1 },
      errors: [error.message],
    };
  }

  const counts = { scanned: 0, patch_updated: 0, yank_migrated: 0, suspended: 0, errors: 0 };
  const errors: string[] = [];

  for (const install of ((data ?? []) as InstallRow[])) {
    counts.scanned++;
    try {
      const versions = await publishedVersions(install.agent_id);
      const current = versions.find((v) => v.version === install.agent_version);
      if (current?.yanked) {
        const fallback = nearestPatchFromRows(versions, install.agent_version);
        if (fallback) {
          await updateInstallVersion(install, fallback.version);
          await recordInstallMetric({
            agentId: install.agent_id,
            userId: install.user_id,
            eventType: "yank_migrated",
            agentVersion: fallback.version,
            metadata: { from_version: install.agent_version },
          });
          await markYankProgress(install.agent_id, install.agent_version, "migrated");
          counts.yank_migrated++;
        } else {
          await suspendInstall(install);
          await markYankProgress(install.agent_id, install.agent_version, "blocked");
          counts.suspended++;
        }
        continue;
      }

      const patch = latestPatchFromRows(versions, install.agent_version);
      if (patch && patch.version !== install.agent_version) {
        await updateInstallVersion(install, patch.version);
        await recordInstallMetric({
          agentId: install.agent_id,
          userId: install.user_id,
          eventType: "update_completed",
          agentVersion: patch.version,
          metadata: { from_version: install.agent_version, update_kind: "patch" },
        });
        counts.patch_updated++;
      }
    } catch (err) {
      counts.errors++;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  await finalizeCompletedYanks();

  return {
    ok: counts.errors === 0,
    counts,
    errors: errors.slice(0, 10),
  };
}

async function updateInstallVersion(install: InstallRow, version: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db
    .from("agent_installs")
    .update({ agent_version: version, pinned_version: null, updated_at: new Date().toISOString() })
    .eq("user_id", install.user_id)
    .eq("agent_id", install.agent_id);
}

async function suspendInstall(install: InstallRow): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db
    .from("agent_installs")
    .update({ state: "suspended", updated_at: new Date().toISOString() })
    .eq("user_id", install.user_id)
    .eq("agent_id", install.agent_id);
}

async function impactedInstallCount(agentId: string, version: string): Promise<number> {
  const db = getSupabase();
  if (!db) return 0;
  const { count } = await db
    .from("agent_installs")
    .select("*", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("agent_version", version)
    .eq("state", "installed");
  return Number(count ?? 0);
}

async function publishedVersions(agentId: string): Promise<VersionRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("marketplace_agent_versions")
    .select("version, published_at, yanked")
    .eq("agent_id", agentId)
    .not("published_at", "is", null)
    .order("published_at", { ascending: false });
  if (error) throw new Error(`versions_read_failed:${error.message}`);
  return (data ?? []) as VersionRow[];
}

async function nearestNonYankedPatch(agentId: string, version: string): Promise<string | null> {
  const versions = await publishedVersions(agentId);
  return nearestPatchFromRows(versions, version)?.version ?? null;
}

async function markYankProgress(
  agentId: string,
  version: string,
  outcome: "migrated" | "blocked",
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const column = outcome === "migrated" ? "migrated_count" : "blocked_count";
  const { data } = await db
    .from("marketplace_yanked_versions")
    .select("migrated_count, blocked_count")
    .eq("agent_id", agentId)
    .eq("version", version)
    .maybeSingle();
  const current = data as { migrated_count?: number; blocked_count?: number } | null;
  await db
    .from("marketplace_yanked_versions")
    .update({
      migration_state: "migrating",
      [column]: Number(current?.[column] ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("agent_id", agentId)
    .eq("version", version);
}

async function finalizeCompletedYanks(): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { data } = await db
    .from("marketplace_yanked_versions")
    .select("agent_id, version")
    .in("migration_state", ["pending", "migrating", "failed"]);
  for (const row of (data ?? []) as Array<{ agent_id: string; version: string }>) {
    const remaining = await impactedInstallCount(row.agent_id, row.version);
    if (remaining === 0) {
      await db
        .from("marketplace_yanked_versions")
        .update({
          migration_state: "completed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("agent_id", row.agent_id)
        .eq("version", row.version);
    }
  }
}
