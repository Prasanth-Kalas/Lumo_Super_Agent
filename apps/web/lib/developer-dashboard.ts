/**
 * DEV-DASH server-side library.
 *
 * Service-role DB access lives here; each public API route authenticates the
 * user and passes their user id into these functions. Because service-role
 * bypasses RLS, every author-facing read explicitly scopes by the user's
 * profile email or user_id.
 */

import { createHash, randomBytes } from "node:crypto";
import { getSupabase } from "./db.js";
import {
  enqueueIdentityVerificationReview,
  enqueuePromotionReview,
} from "./trust/queue.ts";
import {
  buildDeveloperMetricsRollupRows,
  evaluatePromotionEligibility,
  int,
  metricRate,
  money,
  normalizeWebhookEvents,
  normalizeWebhookUrl,
  parseSubmissionKey,
  stableAuthorUserHash,
  submissionKey,
  type DeveloperIdentityReviewState,
  type DeveloperIdentityTier,
  type DeveloperMetricsRollupRow,
  type DeveloperWebhookEvent,
  type MarketplaceAuthorTier,
  type PromotionRequestState,
  type PromotionTargetTier,
} from "./developer-dashboard-core.js";

export {
  evaluatePromotionEligibility,
  parseSubmissionKey,
  stableAuthorUserHash,
  submissionKey,
  type DeveloperIdentityReviewState,
  type DeveloperIdentityTier,
  type DeveloperWebhookEvent,
  type PromotionRequestState,
  type PromotionTargetTier,
};

export interface DeveloperAgentSummary {
  agent_id: string;
  name: string;
  current_version: string | null;
  trust_tier: MarketplaceAuthorTier;
  state: string;
  killed: boolean;
  category: string | null;
  install_count: number;
  install_velocity_7d: number;
  rating_avg: number | null;
  rating_count: number;
  price_usd: number;
  billing_period: string;
  revenue_split_pct: number;
  author_name: string | null;
  published_at: string | null;
  updated_at: string | null;
  metrics_30d: {
    installs: number;
    invocations: number;
    errors: number;
    error_rate: number;
    total_cost_usd: number;
    developer_share_usd: number;
    median_cost_usd: number | null;
    p95_latency_ms: number | null;
  };
}

export interface DeveloperSubmission {
  id: string;
  agent_id: string;
  version: string;
  review_state: string;
  submitted_at: string;
  published_at: string | null;
  yanked: boolean;
  yanked_at: string | null;
  yanked_reason: string | null;
  bundle_sha256: string | null;
  signature_verified: boolean;
  trust_tier: MarketplaceAuthorTier;
  agent_name: string;
  security_review: AgentSecurityReview | null;
}

export interface AgentSecurityReview {
  reviewer: string;
  reviewed_at: string;
  outcome: "approved" | "rejected" | "needs_changes";
  notes: string | null;
  evidence: Record<string, unknown>;
}

export interface DeveloperAgentMetrics {
  agent: DeveloperAgentSummary;
  window_days: number;
  totals: {
    installs: number;
    invocations: number;
    errors: number;
    error_rate: number;
    total_cost_usd: number;
    developer_share_usd: number;
    median_cost_usd: number | null;
    p95_cost_usd: number | null;
    p95_latency_ms: number | null;
    p99_latency_ms: number | null;
  };
  hourly: DeveloperMetricsRollupRow[];
  recent_invocations: DeveloperInvocationRow[];
  errors: DeveloperErrorRow[];
  versions: DeveloperSubmission[];
  ratings: {
    rating_avg: number | null;
    rating_count: number;
  };
}

export interface DeveloperInvocationRow {
  created_at: string;
  request_id: string;
  capability_id: string | null;
  status: string;
  model_used: string | null;
  total_usd: number;
  developer_share_usd: number;
}

export interface DeveloperErrorRow extends DeveloperInvocationRow {
  redacted_user_id: string;
  mission_step_id: string | null;
  error_code: string | null;
  stack_excerpt: string | null;
}

export interface DeveloperPromotionRequest {
  id: number;
  agent_id: string;
  agent_version: string;
  target_tier: PromotionTargetTier;
  state: PromotionRequestState;
  reason: string | null;
  decision_note: string | null;
  submitted_at: string;
  decided_at: string | null;
}

export interface DeveloperIdentityVerification {
  user_id: string;
  verification_tier: DeveloperIdentityTier;
  review_state: DeveloperIdentityReviewState;
  legal_entity_name: string | null;
  registration_number: string | null;
  registration_country: string | null;
  document_path: string | null;
  evidence: Record<string, unknown>;
  submitted_at: string | null;
  verified_at: string | null;
  verifier: string | null;
  rejection_reason: string | null;
}

export interface DeveloperWebhookRegistration {
  id: string;
  label: string;
  url: string;
  event_types: DeveloperWebhookEvent[];
  active: boolean;
  last_delivery_at: string | null;
  last_delivery_state: "ok" | "failed" | null;
  created_at: string;
  updated_at: string;
}

export interface DeveloperMetricsRollupResult {
  ok: boolean;
  counts: {
    cost_rows: number;
    install_rows: number;
    rollup_rows: number;
    upserted: number;
    errors: number;
  };
  errors: string[];
}

interface DeveloperContext {
  userId: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

interface AgentRow {
  agent_id: string;
  current_version?: string | null;
  trust_tier?: MarketplaceAuthorTier;
  state?: string;
  killed?: boolean;
  category?: string | null;
  install_count?: number | string | null;
  install_velocity_7d?: number | string | null;
  rating_avg?: number | string | null;
  rating_count?: number | string | null;
  price_usd?: number | string | null;
  billing_period?: string | null;
  revenue_split_pct?: number | string | null;
  author_name?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  manifest?: unknown;
}

interface VersionRow {
  agent_id: string;
  version: string;
  review_state: string;
  submitted_at: string;
  published_at: string | null;
  yanked: boolean;
  yanked_at: string | null;
  yanked_reason: string | null;
  bundle_sha256: string | null;
  signature_verified: boolean;
}

interface MetricsRow {
  agent_id: string;
  agent_version: string;
  hour: string;
  install_delta?: number | string | null;
  invocation_count?: number | string | null;
  error_count?: number | string | null;
  p95_latency_ms?: number | string | null;
  p99_latency_ms?: number | string | null;
  median_cost_usd?: number | string | null;
  p95_cost_usd?: number | string | null;
  total_cost_usd?: number | string | null;
  developer_share_usd?: number | string | null;
  top_capabilities?: unknown;
}

export async function getDeveloperAgents(userId: string): Promise<DeveloperAgentSummary[]> {
  const db = getSupabase();
  if (!db) return [];
  const context = await getDeveloperContext(userId);
  if (!context.email) return [];

  const { data, error } = await db
    .from("marketplace_agents")
    .select(
      [
        "agent_id",
        "current_version",
        "trust_tier",
        "state",
        "killed",
        "category",
        "install_count",
        "install_velocity_7d",
        "rating_avg",
        "rating_count",
        "price_usd",
        "billing_period",
        "revenue_split_pct",
        "author_name",
        "published_at",
        "updated_at",
        "manifest",
      ].join(", "),
    )
    .eq("author_email", context.email)
    .order("updated_at", { ascending: false });

  if (error) {
    console.warn("[developer-dashboard] getDeveloperAgents failed:", error.message);
    return [];
  }

  const agents = (data ?? []) as unknown as AgentRow[];
  if (agents.length === 0) return [];
  const metrics = await metricsByAgent(agents.map((agent) => agent.agent_id), 30);
  return agents.map((agent) => toAgentSummary(agent, metrics.get(agent.agent_id) ?? []));
}

export async function getDeveloperAgentMetrics(input: {
  userId: string;
  agentId: string;
  windowDays?: number;
}): Promise<DeveloperAgentMetrics | null> {
  const windowDays = clampDays(input.windowDays, 30);
  const agent = await getOwnedAgent(input.userId, input.agentId);
  if (!agent) return null;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const db = getSupabase();
  if (!db) return null;

  const [{ data: metricRows }, { data: costRows }, versions] = await Promise.all([
    db
      .from("developer_agent_metrics_hourly")
      .select("*")
      .eq("agent_id", input.agentId)
      .gte("hour", since)
      .order("hour", { ascending: true }),
    db
      .from("agent_cost_log")
      .select(
        "created_at, request_id, user_id, capability_id, status, model_used, cost_usd_total, cost_usd_developer_share, mission_step_id, evidence",
      )
      .eq("agent_id", input.agentId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
    getSubmissionStatus(input.userId, input.agentId),
  ]);

  const hourly = ((metricRows ?? []) as MetricsRow[]).map(toMetricRow);
  const recentRows = ((costRows ?? []) as Array<Record<string, unknown>>).map(toInvocationRow);
  const errors = ((costRows ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.status !== "completed")
    .map((row) => toErrorRow(row, input.userId));

  return {
    agent,
    window_days: windowDays,
    totals: summarizeMetrics(hourly),
    hourly,
    recent_invocations: recentRows,
    errors,
    versions,
    ratings: {
      rating_avg: agent.rating_avg,
      rating_count: agent.rating_count,
    },
  };
}

export async function getSubmissionStatus(
  userId: string,
  agentId?: string | null,
): Promise<DeveloperSubmission[]> {
  const db = getSupabase();
  if (!db) return [];
  const ownedAgent = agentId ? await getOwnedAgent(userId, agentId) : null;
  const agents = agentId ? (ownedAgent ? [ownedAgent] : []) : await getDeveloperAgents(userId);
  const ownedAgents = agents.filter(Boolean) as unknown as DeveloperAgentSummary[];
  const agentIds = ownedAgents.map((agent) => agent.agent_id);
  if (agentIds.length === 0) return [];

  const [{ data: versions }, { data: reviews }] = await Promise.all([
    db
      .from("marketplace_agent_versions")
      .select(
        "agent_id, version, review_state, submitted_at, published_at, yanked, yanked_at, yanked_reason, bundle_sha256, signature_verified",
      )
      .in("agent_id", agentIds)
      .order("submitted_at", { ascending: false }),
    db
      .from("agent_security_reviews")
      .select("agent_id, agent_version, reviewer, reviewed_at, outcome, notes, evidence")
      .in("agent_id", agentIds),
  ]);

  const agentById = new Map(ownedAgents.map((agent) => [agent.agent_id, agent]));
  const reviewByVersion = new Map(
    ((reviews ?? []) as Array<Record<string, unknown>>).map((row) => [
      `${row.agent_id}:${row.agent_version}`,
      toSecurityReview(row),
    ]),
  );

  return ((versions ?? []) as VersionRow[]).map((version) => {
    const agent = agentById.get(version.agent_id);
    return {
      id: submissionKey(version.agent_id, version.version),
      agent_id: version.agent_id,
      version: version.version,
      review_state: version.review_state,
      submitted_at: version.submitted_at,
      published_at: version.published_at,
      yanked: version.yanked === true,
      yanked_at: version.yanked_at,
      yanked_reason: version.yanked_reason,
      bundle_sha256: version.bundle_sha256,
      signature_verified: version.signature_verified === true,
      trust_tier: agent?.trust_tier ?? "experimental",
      agent_name: agent?.name ?? version.agent_id,
      security_review: reviewByVersion.get(`${version.agent_id}:${version.version}`) ?? null,
    };
  });
}

export async function getSubmissionDetail(input: {
  userId: string;
  submissionId: string;
}): Promise<DeveloperSubmission | null> {
  const parsed = parseSubmissionKey(input.submissionId);
  if (!parsed) return null;
  const submissions = await getSubmissionStatus(input.userId, parsed.agentId);
  return submissions.find((submission) => submission.version === parsed.version) ?? null;
}

export async function listPromotionRequests(
  userId: string,
): Promise<DeveloperPromotionRequest[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("developer_promotion_requests")
    .select("id, agent_id, agent_version, target_tier, state, reason, decision_note, submitted_at, decided_at")
    .eq("requested_by", userId)
    .order("submitted_at", { ascending: false });
  if (error) {
    console.warn("[developer-dashboard] listPromotionRequests failed:", error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(toPromotionRequest);
}

export async function requestPromotion(input: {
  userId: string;
  agentId: string;
  targetTier: PromotionTargetTier;
  reason?: string | null;
}): Promise<
  | { ok: true; request: DeveloperPromotionRequest }
  | { ok: false; error: string; status: number }
> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "db_unavailable", status: 503 };
  const agent = await getOwnedAgent(input.userId, input.agentId);
  if (!agent) return { ok: false, error: "agent_not_found", status: 404 };
  if (!agent.current_version) return { ok: false, error: "agent_has_no_version", status: 409 };
  const identity = await getIdentityVerification(input.userId);
  const eligibility = evaluatePromotionEligibility({
    currentTier: agent.trust_tier,
    targetTier: input.targetTier,
    identityTier: identity.verification_tier,
  });
  if (!eligibility.ok) {
    return { ok: false, error: eligibility.reason, status: 409 };
  }

  const { data, error } = await db
    .from("developer_promotion_requests")
    .insert({
      agent_id: agent.agent_id,
      agent_version: agent.current_version,
      requested_by: input.userId,
      target_tier: input.targetTier,
      state: "pending",
      reason: input.reason?.trim() || null,
    })
    .select("id, agent_id, agent_version, target_tier, state, reason, decision_note, submitted_at, decided_at")
    .single();
  if (error) return { ok: false, error: error.message, status: 409 };
  const request = toPromotionRequest(data as Record<string, unknown>);
  try {
    await enqueuePromotionReview({
      db,
      promotionRequestId: request.id,
      agentId: request.agent_id,
      version: request.agent_version,
      targetTier: request.target_tier,
      eligibilityReport: {
        eligible: true,
        identity_tier: identity.verification_tier,
        current_tier: agent.trust_tier,
      },
    });
  } catch (err) {
    console.warn("[developer-dashboard] enqueuePromotionReview failed:", err instanceof Error ? err.message : String(err));
  }
  return { ok: true, request };
}

export async function getIdentityVerification(
  userId: string,
): Promise<DeveloperIdentityVerification> {
  const db = getSupabase();
  const context = await getDeveloperContext(userId);
  if (!db) return defaultIdentity(userId, context.email ? "email_verified" : "unverified");
  const { data } = await db
    .from("developer_identity_verifications")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return defaultIdentity(userId, context.email ? "email_verified" : "unverified");
  return toIdentityVerification(data as Record<string, unknown>);
}

export async function submitIdentityEvidence(input: {
  userId: string;
  legalEntityName: string;
  registrationNumber?: string | null;
  registrationCountry?: string | null;
  documentPath: string;
  evidence?: Record<string, unknown>;
}): Promise<
  | { ok: true; identity: DeveloperIdentityVerification }
  | { ok: false; error: string; status: number }
> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "db_unavailable", status: 503 };
  await ensureDeveloperProfile(input.userId);
  const legalEntityName = input.legalEntityName.trim();
  const documentPath = input.documentPath.trim();
  const country = input.registrationCountry?.trim().toUpperCase() || null;
  if (!legalEntityName) return { ok: false, error: "missing_legal_entity_name", status: 400 };
  if (!documentPath) return { ok: false, error: "missing_document_path", status: 400 };
  if (country && !/^[A-Z]{2}$/.test(country)) {
    return { ok: false, error: "invalid_registration_country", status: 400 };
  }

  const { data, error } = await db
    .from("developer_identity_verifications")
    .upsert(
      {
        user_id: input.userId,
        verification_tier: "email_verified",
        review_state: "pending",
        legal_entity_name: legalEntityName,
        registration_number: input.registrationNumber?.trim() || null,
        registration_country: country,
        document_path: documentPath,
        evidence: input.evidence ?? {},
        submitted_at: new Date().toISOString(),
        verified_at: null,
        verifier: null,
        rejection_reason: null,
      },
      { onConflict: "user_id" },
    )
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message, status: 409 };
  const identity = toIdentityVerification(data as Record<string, unknown>);
  try {
    await enqueueIdentityVerificationReview({
      db,
      userId: input.userId,
      evidence: {
        legal_entity_name: legalEntityName,
        registration_country: country,
      },
    });
  } catch (err) {
    console.warn("[developer-dashboard] enqueueIdentityVerificationReview failed:", err instanceof Error ? err.message : String(err));
  }
  return { ok: true, identity };
}

export async function listDeveloperWebhooks(
  userId: string,
): Promise<DeveloperWebhookRegistration[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("developer_webhooks")
    .select("id, label, url, event_types, active, last_delivery_at, last_delivery_state, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) {
    console.warn("[developer-dashboard] listDeveloperWebhooks failed:", error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(toWebhook);
}

export async function registerDeveloperWebhook(input: {
  userId: string;
  label: string;
  url: string;
  eventTypes?: unknown;
}): Promise<
  | { ok: true; webhook: DeveloperWebhookRegistration }
  | { ok: false; error: string; status: number }
> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "db_unavailable", status: 503 };
  await ensureDeveloperProfile(input.userId);
  const label = input.label.trim();
  const url = normalizeWebhookUrl(input.url);
  const eventTypes = normalizeWebhookEvents(input.eventTypes);
  if (!label) return { ok: false, error: "missing_label", status: 400 };
  if (!url) return { ok: false, error: "invalid_webhook_url", status: 400 };
  if (eventTypes.length === 0) return { ok: false, error: "missing_event_types", status: 400 };

  const { data, error } = await db
    .from("developer_webhooks")
    .insert({
      user_id: input.userId,
      label,
      url,
      event_types: eventTypes,
      active: true,
      secret_token_hash: webhookSecretHash(randomBytes(24).toString("base64url")),
    })
    .select("id, label, url, event_types, active, last_delivery_at, last_delivery_state, created_at, updated_at")
    .single();
  if (error) return { ok: false, error: error.message, status: 409 };
  return { ok: true, webhook: toWebhook(data as Record<string, unknown>) };
}

export async function updateDeveloperWebhook(input: {
  userId: string;
  webhookId: string;
  label?: string | null;
  url?: string | null;
  eventTypes?: unknown;
  active?: boolean | null;
}): Promise<
  | { ok: true; webhook: DeveloperWebhookRegistration }
  | { ok: false; error: string; status: number }
> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "db_unavailable", status: 503 };
  const patch: Record<string, unknown> = {};
  if (input.label !== undefined) {
    const label = input.label?.trim() ?? "";
    if (!label) return { ok: false, error: "missing_label", status: 400 };
    patch.label = label;
  }
  if (input.url !== undefined) {
    const url = normalizeWebhookUrl(input.url);
    if (!url) return { ok: false, error: "invalid_webhook_url", status: 400 };
    patch.url = url;
  }
  if (input.eventTypes !== undefined) {
    const eventTypes = normalizeWebhookEvents(input.eventTypes);
    if (eventTypes.length === 0) {
      return { ok: false, error: "missing_event_types", status: 400 };
    }
    patch.event_types = eventTypes;
  }
  if (input.active !== undefined && input.active !== null) {
    patch.active = input.active === true;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "empty_update", status: 400 };
  }
  const { data, error } = await db
    .from("developer_webhooks")
    .update(patch)
    .eq("user_id", input.userId)
    .eq("id", input.webhookId)
    .select("id, label, url, event_types, active, last_delivery_at, last_delivery_state, created_at, updated_at")
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 409 };
  if (!data) return { ok: false, error: "webhook_not_found", status: 404 };
  return { ok: true, webhook: toWebhook(data as Record<string, unknown>) };
}

export async function runDeveloperMetricsRollup(args: {
  limit?: number;
} = {}): Promise<DeveloperMetricsRollupResult> {
  const db = getSupabase();
  if (!db) {
    return {
      ok: false,
      counts: { cost_rows: 0, install_rows: 0, rollup_rows: 0, upserted: 0, errors: 1 },
      errors: ["dev_dash_persistence_unavailable"],
    };
  }
  const limit = Math.max(1, Math.min(100_000, Math.trunc(args.limit ?? 50_000)));
  const end = new Date();
  end.setUTCMinutes(0, 0, 0);
  const start = new Date(end.getTime() - 2 * 60 * 60 * 1000);

  const [{ data: costRows, error: costError }, { data: installRows, error: installError }] =
    await Promise.all([
      db
        .from("agent_cost_log")
        .select("agent_id, agent_version, capability_id, status, cost_usd_total, cost_usd_developer_share, evidence, created_at")
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString())
        .limit(limit),
      db
        .from("marketplace_install_metrics")
        .select("agent_id, agent_version, event_type, created_at")
        .eq("event_type", "install_completed")
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString())
        .limit(limit),
    ]);

  const errors = [costError?.message, installError?.message].filter(Boolean) as string[];
  if (errors.length > 0) {
    return {
      ok: false,
      counts: {
        cost_rows: costRows?.length ?? 0,
        install_rows: installRows?.length ?? 0,
        rollup_rows: 0,
        upserted: 0,
        errors: errors.length,
      },
      errors,
    };
  }

  const rows = buildDeveloperMetricsRollupRows({
    costRows: (costRows ?? []) as Array<Record<string, unknown>>,
    installRows: (installRows ?? []) as Array<Record<string, unknown>>,
  });
  if (rows.length === 0) {
    return {
      ok: true,
      counts: {
        cost_rows: costRows?.length ?? 0,
        install_rows: installRows?.length ?? 0,
        rollup_rows: 0,
        upserted: 0,
        errors: 0,
      },
      errors: [],
    };
  }

  const { error } = await db.from("developer_agent_metrics_hourly").upsert(rows, {
    onConflict: "agent_id,agent_version,hour",
  });
  if (error) {
    return {
      ok: false,
      counts: {
        cost_rows: costRows?.length ?? 0,
        install_rows: installRows?.length ?? 0,
        rollup_rows: rows.length,
        upserted: 0,
        errors: 1,
      },
      errors: [error.message],
    };
  }
  return {
    ok: true,
    counts: {
      cost_rows: costRows?.length ?? 0,
      install_rows: installRows?.length ?? 0,
      rollup_rows: rows.length,
      upserted: rows.length,
      errors: 0,
    },
    errors: [],
  };
}

async function getOwnedAgent(
  userId: string,
  agentId: string,
): Promise<DeveloperAgentSummary | null> {
  const agents = await getDeveloperAgents(userId);
  return agents.find((agent) => agent.agent_id === agentId) ?? null;
}

async function getDeveloperContext(userId: string): Promise<DeveloperContext> {
  const db = getSupabase();
  if (!db) return { userId, email: null, displayName: "Developer", avatarUrl: null };
  const { data } = await db
    .from("profiles")
    .select("id, email, full_name, avatar_url")
    .eq("id", userId)
    .maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;
  const email =
    typeof row.email === "string" && row.email.trim()
      ? row.email.trim().toLowerCase()
      : null;
  return {
    userId,
    email,
    displayName:
      typeof row.full_name === "string" && row.full_name.trim()
        ? row.full_name.trim()
        : email?.split("@")[0] ?? "Developer",
    avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
  };
}

async function ensureDeveloperProfile(userId: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const context = await getDeveloperContext(userId);
  await db.from("developer_profiles").upsert(
    {
      user_id: userId,
      display_name: context.displayName,
      contact_email: context.email,
      avatar_url: context.avatarUrl,
    },
    { onConflict: "user_id" },
  );
}

async function metricsByAgent(
  agentIds: string[],
  days: number,
): Promise<Map<string, MetricsRow[]>> {
  const db = getSupabase();
  const out = new Map<string, MetricsRow[]>();
  if (!db || agentIds.length === 0) return out;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("developer_agent_metrics_hourly")
    .select("*")
    .in("agent_id", agentIds)
    .gte("hour", since)
    .order("hour", { ascending: true });
  if (error) {
    console.warn("[developer-dashboard] metricsByAgent failed:", error.message);
    return out;
  }
  for (const row of (data ?? []) as MetricsRow[]) {
    const current = out.get(row.agent_id) ?? [];
    current.push(row);
    out.set(row.agent_id, current);
  }
  return out;
}

function toAgentSummary(agent: AgentRow, rows: MetricsRow[]): DeveloperAgentSummary {
  const mapped = rows.map(toMetricRow);
  const totals = summarizeMetrics(mapped);
  return {
    agent_id: agent.agent_id,
    name: agentName(agent),
    current_version: agent.current_version ?? null,
    trust_tier: isAuthorTier(agent.trust_tier) ? agent.trust_tier : "experimental",
    state: agent.state ?? "pending_review",
    killed: agent.killed === true,
    category: agent.category ?? null,
    install_count: int(agent.install_count),
    install_velocity_7d: int(agent.install_velocity_7d),
    rating_avg: nullableMoney(agent.rating_avg),
    rating_count: int(agent.rating_count),
    price_usd: money(agent.price_usd),
    billing_period: agent.billing_period ?? "one_time",
    revenue_split_pct: money(agent.revenue_split_pct),
    author_name: agent.author_name ?? null,
    published_at: agent.published_at ?? null,
    updated_at: agent.updated_at ?? null,
    metrics_30d: {
      installs: totals.installs,
      invocations: totals.invocations,
      errors: totals.errors,
      error_rate: totals.error_rate,
      total_cost_usd: totals.total_cost_usd,
      developer_share_usd: totals.developer_share_usd,
      median_cost_usd: totals.median_cost_usd,
      p95_latency_ms: totals.p95_latency_ms,
    },
  };
}

function agentName(agent: AgentRow): string {
  if (isRecord(agent.manifest)) {
    const displayName = agent.manifest.display_name;
    const name = agent.manifest.name;
    if (typeof displayName === "string" && displayName.trim()) return displayName.trim();
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return agent.author_name || agent.agent_id;
}

function summarizeMetrics(rows: DeveloperMetricsRollupRow[]): DeveloperAgentMetrics["totals"] {
  const invocations = rows.reduce((sum, row) => sum + row.invocation_count, 0);
  const errors = rows.reduce((sum, row) => sum + row.error_count, 0);
  return {
    installs: rows.reduce((sum, row) => sum + row.install_delta, 0),
    invocations,
    errors,
    error_rate: metricRate(errors, invocations),
    total_cost_usd: money(rows.reduce((sum, row) => sum + row.total_cost_usd, 0)),
    developer_share_usd: money(rows.reduce((sum, row) => sum + row.developer_share_usd, 0)),
    median_cost_usd: latestNonNull(rows.map((row) => row.median_cost_usd)),
    p95_cost_usd: latestNonNull(rows.map((row) => row.p95_cost_usd)),
    p95_latency_ms: latestNonNull(rows.map((row) => row.p95_latency_ms)),
    p99_latency_ms: latestNonNull(rows.map((row) => row.p99_latency_ms)),
  };
}

function toMetricRow(row: MetricsRow): DeveloperMetricsRollupRow {
  const topCapabilities = Array.isArray(row.top_capabilities)
    ? row.top_capabilities
        .filter(isRecord)
        .map((capability) => ({
          capability_id:
            typeof capability.capability_id === "string" ? capability.capability_id : "unknown",
          invocation_count: int(capability.invocation_count),
        }))
    : [];
  return {
    agent_id: row.agent_id,
    agent_version: row.agent_version,
    hour: row.hour,
    install_delta: int(row.install_delta),
    invocation_count: int(row.invocation_count),
    error_count: int(row.error_count),
    p95_latency_ms: nullableInt(row.p95_latency_ms),
    p99_latency_ms: nullableInt(row.p99_latency_ms),
    median_cost_usd: nullableMoney(row.median_cost_usd),
    p95_cost_usd: nullableMoney(row.p95_cost_usd),
    total_cost_usd: money(row.total_cost_usd),
    developer_share_usd: money(row.developer_share_usd),
    top_capabilities: topCapabilities,
  };
}

function toInvocationRow(row: Record<string, unknown>): DeveloperInvocationRow {
  return {
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    request_id: typeof row.request_id === "string" ? row.request_id : "",
    capability_id: typeof row.capability_id === "string" ? row.capability_id : null,
    status: typeof row.status === "string" ? row.status : "completed",
    model_used: typeof row.model_used === "string" ? row.model_used : null,
    total_usd: money(row.cost_usd_total),
    developer_share_usd: money(row.cost_usd_developer_share),
  };
}

function toErrorRow(row: Record<string, unknown>, authorUserId: string): DeveloperErrorRow {
  const invocation = toInvocationRow(row);
  const evidence = isRecord(row.evidence) ? row.evidence : {};
  const userId = typeof row.user_id === "string" ? row.user_id : "unknown";
  return {
    ...invocation,
    redacted_user_id: stableAuthorUserHash(authorUserId, userId),
    mission_step_id: typeof row.mission_step_id === "string" ? row.mission_step_id : null,
    error_code:
      typeof evidence.error_code === "string"
        ? evidence.error_code
        : typeof evidence.budget_code === "string"
          ? evidence.budget_code
          : null,
    stack_excerpt:
      typeof evidence.stack === "string" ? evidence.stack.slice(0, 500) : null,
  };
}

function toSecurityReview(row: Record<string, unknown>): AgentSecurityReview | null {
  if (typeof row.outcome !== "string") return null;
  if (!["approved", "rejected", "needs_changes"].includes(row.outcome)) return null;
  return {
    reviewer: typeof row.reviewer === "string" ? row.reviewer : "unknown",
    reviewed_at: typeof row.reviewed_at === "string" ? row.reviewed_at : "",
    outcome: row.outcome as AgentSecurityReview["outcome"],
    notes: typeof row.notes === "string" ? row.notes : null,
    evidence: isRecord(row.evidence) ? row.evidence : {},
  };
}

function toPromotionRequest(row: Record<string, unknown>): DeveloperPromotionRequest {
  return {
    id: int(row.id),
    agent_id: String(row.agent_id ?? ""),
    agent_version: String(row.agent_version ?? ""),
    target_tier: isPromotionTier(row.target_tier) ? row.target_tier : "community",
    state: isPromotionState(row.state) ? row.state : "pending",
    reason: typeof row.reason === "string" ? row.reason : null,
    decision_note: typeof row.decision_note === "string" ? row.decision_note : null,
    submitted_at: typeof row.submitted_at === "string" ? row.submitted_at : "",
    decided_at: typeof row.decided_at === "string" ? row.decided_at : null,
  };
}

function toIdentityVerification(row: Record<string, unknown>): DeveloperIdentityVerification {
  return {
    user_id: String(row.user_id ?? ""),
    verification_tier: isIdentityTier(row.verification_tier)
      ? row.verification_tier
      : "unverified",
    review_state: isReviewState(row.review_state) ? row.review_state : "not_submitted",
    legal_entity_name: typeof row.legal_entity_name === "string" ? row.legal_entity_name : null,
    registration_number:
      typeof row.registration_number === "string" ? row.registration_number : null,
    registration_country:
      typeof row.registration_country === "string" ? row.registration_country : null,
    document_path: typeof row.document_path === "string" ? row.document_path : null,
    evidence: isRecord(row.evidence) ? row.evidence : {},
    submitted_at: typeof row.submitted_at === "string" ? row.submitted_at : null,
    verified_at: typeof row.verified_at === "string" ? row.verified_at : null,
    verifier: typeof row.verifier === "string" ? row.verifier : null,
    rejection_reason: typeof row.rejection_reason === "string" ? row.rejection_reason : null,
  };
}

function defaultIdentity(
  userId: string,
  tier: DeveloperIdentityTier,
): DeveloperIdentityVerification {
  return {
    user_id: userId,
    verification_tier: tier,
    review_state: "not_submitted",
    legal_entity_name: null,
    registration_number: null,
    registration_country: null,
    document_path: null,
    evidence: {},
    submitted_at: null,
    verified_at: null,
    verifier: null,
    rejection_reason: null,
  };
}

function toWebhook(row: Record<string, unknown>): DeveloperWebhookRegistration {
  const eventTypes = normalizeWebhookEvents(row.event_types);
  return {
    id: String(row.id ?? ""),
    label: String(row.label ?? ""),
    url: String(row.url ?? ""),
    event_types: eventTypes.length > 0 ? eventTypes : ["install_completed"],
    active: row.active !== false,
    last_delivery_at: typeof row.last_delivery_at === "string" ? row.last_delivery_at : null,
    last_delivery_state:
      row.last_delivery_state === "ok" || row.last_delivery_state === "failed"
        ? row.last_delivery_state
        : null,
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

function webhookSecretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function latestNonNull<T extends number>(values: Array<T | null>): T | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function nullableMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return money(value);
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return int(value);
}

function clampDays(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(90, Math.trunc(parsed)));
}

function isAuthorTier(value: unknown): value is MarketplaceAuthorTier {
  return (
    value === "experimental" ||
    value === "community" ||
    value === "verified" ||
    value === "official"
  );
}

function isPromotionTier(value: unknown): value is PromotionTargetTier {
  return value === "community" || value === "verified" || value === "official";
}

function isPromotionState(value: unknown): value is PromotionRequestState {
  return value === "pending" || value === "approved" || value === "rejected" || value === "withdrawn";
}

function isIdentityTier(value: unknown): value is DeveloperIdentityTier {
  return value === "unverified" || value === "email_verified" || value === "legal_entity_verified";
}

function isReviewState(value: unknown): value is DeveloperIdentityReviewState {
  return (
    value === "not_submitted" ||
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "needs_changes"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
