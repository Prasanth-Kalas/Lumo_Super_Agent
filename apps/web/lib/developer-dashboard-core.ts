/**
 * Pure DEV-DASH helpers.
 *
 * Kept free of DB and Next imports so the dashboard math can be tested without
 * Supabase. The DB-facing wrapper lives in developer-dashboard.ts.
 */

import { createHash } from "node:crypto";

export type DeveloperIdentityTier =
  | "unverified"
  | "email_verified"
  | "legal_entity_verified";

export type DeveloperIdentityReviewState =
  | "not_submitted"
  | "pending"
  | "approved"
  | "rejected"
  | "needs_changes";

export type PromotionTargetTier = "community" | "verified" | "official";
export type MarketplaceAuthorTier =
  | "experimental"
  | "community"
  | "verified"
  | "official";

export type PromotionRequestState =
  | "pending"
  | "approved"
  | "rejected"
  | "withdrawn";

export interface DeveloperMetricsCostRow {
  agent_id?: unknown;
  agent_version?: unknown;
  capability_id?: unknown;
  status?: unknown;
  cost_usd_total?: unknown;
  cost_usd_developer_share?: unknown;
  evidence?: unknown;
  created_at?: unknown;
}

export interface DeveloperMetricsInstallRow {
  agent_id?: unknown;
  agent_version?: unknown;
  event_type?: unknown;
  created_at?: unknown;
}

export interface DeveloperMetricsRollupRow {
  agent_id: string;
  agent_version: string;
  hour: string;
  install_delta: number;
  invocation_count: number;
  error_count: number;
  p95_latency_ms: number | null;
  p99_latency_ms: number | null;
  median_cost_usd: number | null;
  p95_cost_usd: number | null;
  total_cost_usd: number;
  developer_share_usd: number;
  top_capabilities: Array<{
    capability_id: string;
    invocation_count: number;
  }>;
}

export interface PromotionEligibilityResult {
  ok: boolean;
  reason:
    | "eligible"
    | "already_at_or_above_target"
    | "email_verification_required"
    | "legal_entity_verification_required"
    | "official_is_lumo_only";
}

const TIER_ORDER: Record<MarketplaceAuthorTier, number> = {
  experimental: 0,
  community: 1,
  verified: 2,
  official: 3,
};

const IDENTITY_ORDER: Record<DeveloperIdentityTier, number> = {
  unverified: 0,
  email_verified: 1,
  legal_entity_verified: 2,
};

export const DEVELOPER_WEBHOOK_EVENTS = [
  "view",
  "install_started",
  "install_completed",
  "uninstall_completed",
  "version_published",
  "version_yanked",
  "promotion_decided",
  "transaction_completed",
] as const;

export type DeveloperWebhookEvent = (typeof DEVELOPER_WEBHOOK_EVENTS)[number];

export function evaluatePromotionEligibility(input: {
  currentTier: MarketplaceAuthorTier;
  targetTier: PromotionTargetTier;
  identityTier: DeveloperIdentityTier;
  isLumoTeam?: boolean;
}): PromotionEligibilityResult {
  if (TIER_ORDER[input.currentTier] >= TIER_ORDER[input.targetTier]) {
    return { ok: false, reason: "already_at_or_above_target" };
  }
  if (
    input.targetTier === "community" &&
    IDENTITY_ORDER[input.identityTier] < IDENTITY_ORDER.email_verified
  ) {
    return { ok: false, reason: "email_verification_required" };
  }
  if (
    input.targetTier === "verified" &&
    IDENTITY_ORDER[input.identityTier] < IDENTITY_ORDER.legal_entity_verified
  ) {
    return { ok: false, reason: "legal_entity_verification_required" };
  }
  if (input.targetTier === "official" && input.isLumoTeam !== true) {
    return { ok: false, reason: "official_is_lumo_only" };
  }
  return { ok: true, reason: "eligible" };
}

export function stableAuthorUserHash(authorUserId: string, rawUserId: string): string {
  const digest = createHash("sha256")
    .update(`${authorUserId}:${rawUserId}`)
    .digest("hex")
    .slice(0, 16);
  return `du_${digest}`;
}

export function submissionKey(agentId: string, version: string): string {
  return Buffer.from(JSON.stringify({ agent_id: agentId, version }), "utf8").toString(
    "base64url",
  );
}

export function parseSubmissionKey(key: string): { agentId: string; version: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(key, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)) return null;
    const agentId = typeof decoded.agent_id === "string" ? decoded.agent_id : "";
    const version = typeof decoded.version === "string" ? decoded.version : "";
    if (!agentId || !version) return null;
    return { agentId, version };
  } catch {
    return null;
  }
}

export function normalizeWebhookEvents(input: unknown): DeveloperWebhookEvent[] {
  if (!Array.isArray(input)) return ["install_completed", "uninstall_completed"];
  const allowed = new Set<string>(DEVELOPER_WEBHOOK_EVENTS);
  const events = input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value): value is DeveloperWebhookEvent => allowed.has(value));
  return [...new Set(events)].slice(0, DEVELOPER_WEBHOOK_EVENTS.length);
}

export function normalizeWebhookUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function buildDeveloperMetricsRollupRows(input: {
  costRows: DeveloperMetricsCostRow[];
  installRows: DeveloperMetricsInstallRow[];
}): DeveloperMetricsRollupRow[] {
  const buckets = new Map<string, MetricsAccumulator>();

  for (const row of input.costRows) {
    const agentId = stringValue(row.agent_id);
    const version = stringValue(row.agent_version);
    const hour = hourStart(row.created_at);
    if (!agentId || !version || !hour) continue;
    const bucket = ensureBucket(buckets, agentId, version, hour);
    bucket.invocation_count++;
    if (row.status !== "completed") bucket.error_count++;
    const total = money(row.cost_usd_total);
    const developerShare = money(row.cost_usd_developer_share);
    bucket.costs.push(total);
    bucket.total_cost_usd = money(bucket.total_cost_usd + total);
    bucket.developer_share_usd = money(bucket.developer_share_usd + developerShare);
    const latency = latencyMs(row.evidence);
    if (latency !== null) bucket.latencies.push(latency);
    const capabilityId = stringValue(row.capability_id) ?? "unknown";
    bucket.capabilities.set(capabilityId, (bucket.capabilities.get(capabilityId) ?? 0) + 1);
  }

  for (const row of input.installRows) {
    if (row.event_type !== "install_completed") continue;
    const agentId = stringValue(row.agent_id);
    const version = stringValue(row.agent_version);
    const hour = hourStart(row.created_at);
    if (!agentId || !version || !hour) continue;
    const bucket = ensureBucket(buckets, agentId, version, hour);
    bucket.install_delta++;
  }

  return [...buckets.values()]
    .map(toRollupRow)
    .sort((a, b) => `${a.agent_id}:${a.agent_version}:${a.hour}`.localeCompare(
      `${b.agent_id}:${b.agent_version}:${b.hour}`,
    ));
}

export function metricRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

interface MetricsAccumulator {
  agent_id: string;
  agent_version: string;
  hour: string;
  install_delta: number;
  invocation_count: number;
  error_count: number;
  total_cost_usd: number;
  developer_share_usd: number;
  costs: number[];
  latencies: number[];
  capabilities: Map<string, number>;
}

function ensureBucket(
  buckets: Map<string, MetricsAccumulator>,
  agentId: string,
  version: string,
  hour: string,
): MetricsAccumulator {
  const key = `${agentId}\u0000${version}\u0000${hour}`;
  const existing = buckets.get(key);
  if (existing) return existing;
  const next: MetricsAccumulator = {
    agent_id: agentId,
    agent_version: version,
    hour,
    install_delta: 0,
    invocation_count: 0,
    error_count: 0,
    total_cost_usd: 0,
    developer_share_usd: 0,
    costs: [],
    latencies: [],
    capabilities: new Map(),
  };
  buckets.set(key, next);
  return next;
}

function toRollupRow(acc: MetricsAccumulator): DeveloperMetricsRollupRow {
  return {
    agent_id: acc.agent_id,
    agent_version: acc.agent_version,
    hour: acc.hour,
    install_delta: acc.install_delta,
    invocation_count: acc.invocation_count,
    error_count: Math.min(acc.error_count, acc.invocation_count),
    p95_latency_ms: percentile(acc.latencies, 0.95, true),
    p99_latency_ms: percentile(acc.latencies, 0.99, true),
    median_cost_usd: percentile(acc.costs, 0.5, false),
    p95_cost_usd: percentile(acc.costs, 0.95, false),
    total_cost_usd: money(acc.total_cost_usd),
    developer_share_usd: money(acc.developer_share_usd),
    top_capabilities: [...acc.capabilities.entries()]
      .map(([capability_id, invocation_count]) => ({ capability_id, invocation_count }))
      .sort((a, b) => b.invocation_count - a.invocation_count || a.capability_id.localeCompare(b.capability_id))
      .slice(0, 10),
  };
}

function hourStart(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function latencyMs(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const candidates = [
    value.latency_ms,
    value.model_latency_ms,
    isRecord(value.runtime) ? value.runtime.latency_ms : undefined,
  ];
  for (const candidate of candidates) {
    const parsed = numberValue(candidate);
    if (parsed !== null && parsed >= 0) return Math.round(parsed);
  }
  return null;
}

function percentile(values: number[], p: number, integer: boolean): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  const value = sorted[index] ?? 0;
  return integer ? Math.round(value) : money(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function money(value: unknown): number {
  const parsed = numberValue(value);
  if (parsed === null || parsed <= 0) return 0;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

export function int(value: unknown): number {
  const parsed = numberValue(value);
  if (parsed === null || parsed <= 0) return 0;
  return Math.trunc(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
