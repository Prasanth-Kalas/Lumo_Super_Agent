/**
 * MARKETPLACE-1 server-side catalog library.
 *
 * The public route still carries some legacy registry shaping while this
 * sprint lands in slices. This module is the durable DB-facing layer:
 * marketplace catalog rows, version metadata, install/uninstall writes, and
 * install metrics. All writes use the service-role Supabase client.
 */

import type { AgentManifest } from "@lumo/agent-sdk";
import { ensureRegistry } from "./agent-registry.js";
import {
  permissionSnapshotForManifest,
  revokeAgentInstall,
  upsertAgentInstall,
} from "./app-installs.js";
import { getSupabase } from "./db.js";
import {
  consentTextForAgent,
  consentTextHash,
  permissionScopesForManifest,
} from "./permission-manifest.js";
import { grantPermission, recordAuditEvent, revokePermission } from "./permissions.js";

export type MarketplaceTrustTier =
  | "official"
  | "verified"
  | "community"
  | "experimental";

export type MarketplaceAgentState =
  | "pending_review"
  | "published"
  | "yanked"
  | "killed"
  | "withdrawn";

export type MarketplaceBillingPeriod =
  | "one_time"
  | "monthly"
  | "annual"
  | "metered";

export interface MarketplaceAgentRecord {
  agent_id: string;
  current_version: string | null;
  pinned_minimum: string | null;
  trust_tier: MarketplaceTrustTier;
  state: MarketplaceAgentState;
  killed: boolean;
  manifest: AgentManifest | null;
  category: string | null;
  install_count: number;
  install_velocity_7d: number;
  rating_avg: number | null;
  rating_count: number;
  bundle_sha256: string | null;
  bundle_path: string | null;
  price_usd: number;
  billing_period: MarketplaceBillingPeriod;
  revenue_split_pct: number;
  author_email: string | null;
  author_name: string | null;
  author_url: string | null;
  homepage: string | null;
  privacy_url: string | null;
  support_url: string | null;
  data_retention_policy: string | null;
  tags: string[];
  published_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface MarketplaceAgentVersion {
  agent_id: string;
  version: string;
  manifest: AgentManifest | null;
  bundle_path: string;
  bundle_sha256: string;
  bundle_size_bytes: number | null;
  signature: string | null;
  signature_verified: boolean;
  review_state:
    | "pending_review"
    | "automated_passed"
    | "approved"
    | "rejected"
    | "needs_changes";
  published_at: string | null;
  submitted_at: string;
  yanked: boolean;
  yanked_reason: string | null;
  yanked_at: string | null;
}

export interface MarketplaceInstallState {
  user_id: string;
  agent_id: string;
  state: "installed" | "suspended" | "revoked";
  agent_version: string;
  pinned_version: string | null;
  installed_at: string;
  revoked_at: string | null;
  updated_at: string;
}

export interface ListAgentsInput {
  userId?: string | null;
  query?: string | null;
  category?: string | null;
  tier?: MarketplaceTrustTier | MarketplaceTrustTier[] | null;
  installedOnly?: boolean;
  page?: number;
  limit?: number;
}

export interface ListAgentsResult {
  agents: MarketplaceAgentRecord[];
  installs: Record<string, MarketplaceInstallState>;
  page: number;
  limit: number;
  total: number;
  source: "db" | "registry_fallback";
}

export interface InstallAgentInput {
  userId: string;
  agentId: string;
  version?: string | null;
  constraintsByScope?: Record<string, Record<string, unknown>>;
  expiresAtByScope?: Record<string, string | null>;
  consentText?: string;
}

export interface UninstallAgentInput {
  userId: string;
  agentId: string;
  deleteData?: boolean;
}

export type MarketplaceMetricEvent =
  | "view"
  | "detail_view"
  | "install_started"
  | "install_completed"
  | "uninstall_completed"
  | "update_available"
  | "update_completed"
  | "yank_migrated";

export async function listAgents(input: ListAgentsInput = {}): Promise<ListAgentsResult> {
  const page = positiveInt(input.page, 1);
  const limit = Math.min(positiveInt(input.limit, 24), 100);
  const offset = (page - 1) * limit;
  const db = getSupabase();
  if (!db) {
    const fallback = await registryFallbackAgents();
    const filtered = filterAgentsInMemory(fallback, input);
    return {
      agents: filtered.slice(offset, offset + limit),
      installs: {},
      page,
      limit,
      total: filtered.length,
      source: "registry_fallback",
    };
  }

  const installIds = input.userId ? await installedAgentIds(input.userId) : new Set<string>();
  if (input.installedOnly && input.userId && installIds.size === 0) {
    return { agents: [], installs: {}, page, limit, total: 0, source: "db" };
  }

  let query = db
    .from("marketplace_agents")
    .select(
      [
        "agent_id",
        "current_version",
        "pinned_minimum",
        "trust_tier",
        "state",
        "killed",
        "manifest",
        "category",
        "install_count",
        "install_velocity_7d",
        "rating_avg",
        "rating_count",
        "bundle_sha256",
        "bundle_path",
        "price_usd",
        "billing_period",
        "revenue_split_pct",
        "author_email",
        "author_name",
        "author_url",
        "homepage",
        "privacy_url",
        "support_url",
        "data_retention_policy",
        "tags",
        "published_at",
        "created_at",
        "updated_at",
      ].join(", "),
      { count: "exact" },
    )
    .eq("state", "published")
    .eq("killed", false)
    .order("install_count", { ascending: false })
    .order("agent_id", { ascending: true });

  const category = normalizeFilter(input.category);
  if (category && category !== "all") query = query.eq("category", category);

  const tiers = normalizeTiers(input.tier);
  if (tiers.length === 1) query = query.eq("trust_tier", tiers[0]);
  if (tiers.length > 1) query = query.in("trust_tier", tiers);

  if (input.installedOnly && installIds.size > 0) {
    query = query.in("agent_id", [...installIds]);
  }

  const q = normalizeSearch(input.query);
  if (q) {
    query = query.textSearch("search_vector", q, {
      type: "websearch",
      config: "english",
    });
  }

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) {
    console.warn("[marketplace] listAgents DB read failed:", error.message);
    const fallback = await registryFallbackAgents();
    const filtered = filterAgentsInMemory(fallback, input);
    return {
      agents: filtered.slice(offset, offset + limit),
      installs: {},
      page,
      limit,
      total: filtered.length,
      source: "registry_fallback",
    };
  }

  const agents = ((data ?? []) as unknown as MarketplaceAgentRow[]).map(
    toMarketplaceAgentRecord,
  );
  const installs = input.userId
    ? await installMapForUser(input.userId, agents.map((agent) => agent.agent_id))
    : {};
  return {
    agents,
    installs,
    page,
    limit,
    total: count ?? agents.length,
    source: "db",
  };
}

export async function searchAgents(
  query: string,
  filters: Omit<ListAgentsInput, "query"> = {},
): Promise<ListAgentsResult> {
  return listAgents({ ...filters, query });
}

export async function getAgent(agentId: string): Promise<MarketplaceAgentRecord | null> {
  const db = getSupabase();
  if (!db) {
    return (await registryFallbackAgents()).find((agent) => agent.agent_id === agentId) ?? null;
  }
  const { data, error } = await db
    .from("marketplace_agents")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) {
    console.warn("[marketplace] getAgent failed:", error.message);
    return null;
  }
  return data ? toMarketplaceAgentRecord(data as MarketplaceAgentRow) : null;
}

export async function getAgentVersions(agentId: string): Promise<MarketplaceAgentVersion[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("marketplace_agent_versions")
    .select(
      "agent_id, version, manifest, bundle_path, bundle_sha256, bundle_size_bytes, signature, signature_verified, review_state, published_at, submitted_at, yanked, yanked_reason, yanked_at",
    )
    .eq("agent_id", agentId)
    .order("submitted_at", { ascending: false });
  if (error) {
    console.warn("[marketplace] getAgentVersions failed:", error.message);
    return [];
  }
  return ((data ?? []) as MarketplaceVersionRow[]).map(toMarketplaceAgentVersion);
}

export async function installAgent(input: InstallAgentInput): Promise<{
  installed: boolean;
  agentId: string;
  version: string;
  grantedScopes: string[];
}> {
  const agent = await getAgent(input.agentId);
  if (!agent?.manifest) throw new Error("marketplace_agent_not_found");

  const version = input.version ?? agent.current_version ?? agent.manifest.version;
  const scopes = permissionScopesForManifest({ ...agent.manifest, version });
  const consentText =
    input.consentText ?? consentTextForAgent({ ...agent.manifest, version }, scopes);
  const hash = consentTextHash(consentText);

  if (scopes.length > 0) {
    const result = await grantPermission({
      userId: input.userId,
      agentId: input.agentId,
      agentVersion: version,
      consentTextHash: hash,
      grantedScopes: scopes.map((scope) => ({
        scope: scope.scope,
        constraints: input.constraintsByScope?.[scope.scope] ?? scope.defaultConstraints,
        expiresAt: input.expiresAtByScope?.[scope.scope] ?? null,
      })),
    });
    await upsertLegacyInstall(input.userId, agent.manifest);
    await recordInstallMetric({
      agentId: input.agentId,
      userId: input.userId,
      eventType: "install_completed",
      agentVersion: version,
      metadata: { scopes: result.grantedScopes },
    });
    return {
      installed: result.installed,
      agentId: input.agentId,
      version,
      grantedScopes: result.grantedScopes,
    };
  }

  const db = getSupabase();
  if (!db) throw new Error("marketplace_persistence_unavailable");
  const now = new Date().toISOString();
  const { error } = await db.from("agent_installs").upsert(
    {
      user_id: input.userId,
      agent_id: input.agentId,
      agent_version: version,
      state: "installed",
      pinned_version: null,
      consent_text_hash: hash,
      revoked_at: null,
      cleanup_after: null,
      updated_at: now,
    },
    { onConflict: "user_id,agent_id" },
  );
  if (error) throw new Error(`marketplace_install_failed:${error.message}`);
  await recordAuditEvent({
    userId: input.userId,
    agentId: input.agentId,
    agentVersion: version,
    scopeUsed: "*",
    action: "agent.installed",
    evidence: { consent_text_hash: hash, source: "marketplace" },
  });
  await upsertLegacyInstall(input.userId, agent.manifest);
  await recordInstallMetric({
    agentId: input.agentId,
    userId: input.userId,
    eventType: "install_completed",
    agentVersion: version,
    metadata: { scopes: [] },
  });
  return { installed: true, agentId: input.agentId, version, grantedScopes: [] };
}

export async function uninstallAgent(input: UninstallAgentInput): Promise<{ revoked: true }> {
  await revokePermission({
    userId: input.userId,
    agentId: input.agentId,
    deleteData: input.deleteData,
  });
  await revokeAgentInstall(input.userId, input.agentId);
  await recordInstallMetric({
    agentId: input.agentId,
    userId: input.userId,
    eventType: "uninstall_completed",
    metadata: { delete_data: input.deleteData === true },
  });
  return { revoked: true };
}

export async function recordInstallMetric(input: {
  agentId: string;
  eventType: MarketplaceMetricEvent;
  userId?: string | null;
  agentVersion?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from("marketplace_install_metrics").insert({
    agent_id: input.agentId,
    user_id: input.userId ?? null,
    event_type: input.eventType,
    agent_version: input.agentVersion ?? null,
    metadata: input.metadata ?? {},
  });
  if (error) {
    console.warn("[marketplace] recordInstallMetric failed:", error.message);
  }
}

async function upsertLegacyInstall(userId: string, manifest: AgentManifest): Promise<void> {
  await upsertAgentInstall({
    user_id: userId,
    agent_id: manifest.agent_id,
    install_source: "marketplace",
    permissions: permissionSnapshotForManifest(manifest),
  });
}

async function installedAgentIds(userId: string): Promise<Set<string>> {
  const db = getSupabase();
  if (!db) return new Set();
  const { data, error } = await db
    .from("agent_installs")
    .select("agent_id")
    .eq("user_id", userId)
    .eq("state", "installed");
  if (error) {
    console.warn("[marketplace] installedAgentIds failed:", error.message);
    return new Set();
  }
  return new Set((data ?? []).map((row) => String((row as { agent_id: string }).agent_id)));
}

async function installMapForUser(
  userId: string,
  agentIds: string[],
): Promise<Record<string, MarketplaceInstallState>> {
  if (agentIds.length === 0) return {};
  const db = getSupabase();
  if (!db) return {};
  const { data, error } = await db
    .from("agent_installs")
    .select("user_id, agent_id, state, agent_version, pinned_version, installed_at, revoked_at, updated_at")
    .eq("user_id", userId)
    .in("agent_id", agentIds);
  if (error) {
    console.warn("[marketplace] installMapForUser failed:", error.message);
    return {};
  }
  return Object.fromEntries(
    ((data ?? []) as InstallRow[]).map((row) => [row.agent_id, toInstallState(row)]),
  );
}

async function registryFallbackAgents(): Promise<MarketplaceAgentRecord[]> {
  const registry = await ensureRegistry();
  return Object.values(registry.agents)
    .filter((entry) => entry.system !== true)
    .map((entry): MarketplaceAgentRecord => {
      const manifest = entry.manifest;
      return {
        agent_id: manifest.agent_id,
        current_version: manifest.version,
        pinned_minimum: null,
        trust_tier: "official",
        state: "published",
        killed: false,
        manifest,
        category: manifest.listing?.category ?? manifest.domain ?? null,
        install_count: 0,
        install_velocity_7d: 0,
        rating_avg: null,
        rating_count: 0,
        bundle_sha256: null,
        bundle_path: null,
        price_usd: 0,
        billing_period: "one_time",
        revenue_split_pct: 0,
        author_email: null,
        author_name: "Lumo",
        author_url: null,
        homepage: null,
        privacy_url: null,
        support_url: null,
        data_retention_policy: null,
        tags: [],
        published_at: null,
        created_at: null,
        updated_at: null,
      };
    });
}

function filterAgentsInMemory(
  agents: MarketplaceAgentRecord[],
  input: ListAgentsInput,
): MarketplaceAgentRecord[] {
  const q = normalizeSearch(input.query);
  const category = normalizeFilter(input.category);
  const tiers = normalizeTiers(input.tier);
  return agents.filter((agent) => {
    if (agent.state !== "published" || agent.killed) return false;
    if (category && category !== "all" && normalizeFilter(agent.category) !== category) return false;
    if (tiers.length > 0 && !tiers.includes(agent.trust_tier)) return false;
    if (q && !agentMatchesQuery(agent, q)) return false;
    return true;
  });
}

function agentMatchesQuery(agent: MarketplaceAgentRecord, q: string): boolean {
  const haystack = [
    agent.agent_id,
    agent.manifest?.display_name,
    agent.manifest?.one_liner,
    manifestDescription(agent.manifest),
    agent.author_name,
    agent.category,
    ...(agent.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

interface MarketplaceAgentRow {
  agent_id: string;
  current_version: string | null;
  pinned_minimum: string | null;
  trust_tier: MarketplaceTrustTier | null;
  state: MarketplaceAgentState | null;
  killed: boolean | null;
  manifest: unknown;
  category: string | null;
  install_count: number | null;
  install_velocity_7d: number | string | null;
  rating_avg: number | string | null;
  rating_count: number | null;
  bundle_sha256: string | null;
  bundle_path: string | null;
  price_usd: number | string | null;
  billing_period: MarketplaceBillingPeriod | null;
  revenue_split_pct: number | string | null;
  author_email: string | null;
  author_name: string | null;
  author_url: string | null;
  homepage: string | null;
  privacy_url: string | null;
  support_url: string | null;
  data_retention_policy: string | null;
  tags: unknown;
  published_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface MarketplaceVersionRow {
  agent_id: string;
  version: string;
  manifest: unknown;
  bundle_path: string;
  bundle_sha256: string;
  bundle_size_bytes: number | null;
  signature: string | null;
  signature_verified: boolean | null;
  review_state: MarketplaceAgentVersion["review_state"] | null;
  published_at: string | null;
  submitted_at: string;
  yanked: boolean | null;
  yanked_reason: string | null;
  yanked_at: string | null;
}

interface InstallRow {
  user_id: string;
  agent_id: string;
  state: MarketplaceInstallState["state"];
  agent_version: string;
  pinned_version: string | null;
  installed_at: string;
  revoked_at: string | null;
  updated_at: string;
}

function toMarketplaceAgentRecord(row: MarketplaceAgentRow): MarketplaceAgentRecord {
  const manifest = normalizeManifest(row.manifest);
  return {
    agent_id: row.agent_id,
    current_version: row.current_version,
    pinned_minimum: row.pinned_minimum,
    trust_tier: row.trust_tier ?? "experimental",
    state: row.state ?? "pending_review",
    killed: row.killed === true,
    manifest,
    category: row.category,
    install_count: Number(row.install_count ?? 0),
    install_velocity_7d: Number(row.install_velocity_7d ?? 0),
    rating_avg: row.rating_avg === null ? null : Number(row.rating_avg),
    rating_count: Number(row.rating_count ?? 0),
    bundle_sha256: row.bundle_sha256,
    bundle_path: row.bundle_path,
    price_usd: Number(row.price_usd ?? 0),
    billing_period: row.billing_period ?? "one_time",
    revenue_split_pct: Number(row.revenue_split_pct ?? 0),
    author_email: row.author_email,
    author_name: row.author_name,
    author_url: row.author_url,
    homepage: row.homepage,
    privacy_url: row.privacy_url,
    support_url: row.support_url,
    data_retention_policy: row.data_retention_policy,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toMarketplaceAgentVersion(row: MarketplaceVersionRow): MarketplaceAgentVersion {
  return {
    agent_id: row.agent_id,
    version: row.version,
    manifest: normalizeManifest(row.manifest),
    bundle_path: row.bundle_path,
    bundle_sha256: row.bundle_sha256,
    bundle_size_bytes: row.bundle_size_bytes,
    signature: row.signature,
    signature_verified: row.signature_verified === true,
    review_state: row.review_state ?? "pending_review",
    published_at: row.published_at,
    submitted_at: row.submitted_at,
    yanked: row.yanked === true,
    yanked_reason: row.yanked_reason,
    yanked_at: row.yanked_at,
  };
}

function toInstallState(row: InstallRow): MarketplaceInstallState {
  return {
    user_id: row.user_id,
    agent_id: row.agent_id,
    state: row.state,
    agent_version: row.agent_version,
    pinned_version: row.pinned_version,
    installed_at: row.installed_at,
    revoked_at: row.revoked_at,
    updated_at: row.updated_at,
  };
}

function normalizeManifest(value: unknown): AgentManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.agent_id !== "string" || typeof record.version !== "string") return null;
  return value as AgentManifest;
}

function manifestDescription(manifest: AgentManifest | null): string {
  if (!manifest) return "";
  const record = manifest as AgentManifest & { description?: unknown };
  return typeof record.description === "string" ? record.description : "";
}

function normalizeTiers(
  tier: MarketplaceTrustTier | MarketplaceTrustTier[] | null | undefined,
): MarketplaceTrustTier[] {
  if (!tier) return [];
  const raw = Array.isArray(tier) ? tier : [tier];
  const allowed = new Set<MarketplaceTrustTier>([
    "official",
    "verified",
    "community",
    "experimental",
  ]);
  return raw.filter((value): value is MarketplaceTrustTier => allowed.has(value));
}

function normalizeFilter(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeSearch(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(Number(value));
  return n > 0 ? n : fallback;
}
