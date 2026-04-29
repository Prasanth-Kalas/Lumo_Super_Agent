import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../db.js";
import type { MarketplaceTrustTier } from "../marketplace.js";

export type ReviewRequestType = "submission" | "promotion" | "identity_verification" | "demotion_review";
export type ReviewQueueState = "pending" | "in_review" | "approved" | "rejected" | "needs_changes" | "withdrawn";

export interface ReviewQueueItem {
  id: string;
  request_type: ReviewRequestType;
  agent_id: string | null;
  agent_version: string | null;
  promotion_request_id: number | null;
  identity_user_id: string | null;
  target_tier: MarketplaceTrustTier | null;
  state: ReviewQueueState;
  priority: "low" | "normal" | "high" | "p0";
  sla_due_at: string;
  submitted_at: string;
  assigned_to: string | null;
  automated_checks: Record<string, unknown>;
  eligibility_report: Record<string, unknown>;
  health_report: Record<string, unknown>;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export function slaForTier(tier: MarketplaceTrustTier): string {
  const due = new Date();
  if (tier === "community") due.setHours(due.getHours() + 24);
  else if (tier === "verified") due.setDate(due.getDate() + 7);
  else if (tier === "official") due.setDate(due.getDate() + 5);
  else due.setHours(due.getHours() + 2);
  return due.toISOString();
}

export async function enqueueSubmissionReview(input: {
  agentId: string;
  version: string;
  targetTier: MarketplaceTrustTier;
  automatedChecks: Record<string, unknown>;
  db?: SupabaseClient | null;
}): Promise<ReviewQueueItem> {
  const db = input.db ?? getSupabase();
  if (!db) throw new Error("db_unavailable");
  const row = {
    request_type: "submission",
    agent_id: input.agentId,
    agent_version: input.version,
    target_tier: input.targetTier,
    state: "pending",
    priority: input.targetTier === "official" ? "high" : "normal",
    sla_due_at: slaForTier(input.targetTier),
    automated_checks: input.automatedChecks,
  };
  return insertQueueRow(db, row, (query) =>
    query
      .eq("request_type", "submission")
      .eq("agent_id", input.agentId)
      .eq("agent_version", input.version)
      .in("state", ["pending", "in_review"]),
  );
}

export async function enqueueDemotionReview(input: {
  agentId: string;
  version: string;
  severity: "P3" | "P2" | "P1" | "P0";
  healthReport: Record<string, unknown>;
  db?: SupabaseClient | null;
}): Promise<ReviewQueueItem | null> {
  const db = input.db ?? getSupabase();
  if (!db) throw new Error("db_unavailable");
  const due = new Date();
  due.setHours(due.getHours() + (input.severity === "P0" ? 1 : 24));
  return insertQueueRow(db, {
    request_type: "demotion_review",
    agent_id: input.agentId,
    agent_version: input.version,
    state: "pending",
    priority: input.severity === "P0" ? "p0" : input.severity === "P1" ? "high" : "normal",
    sla_due_at: due.toISOString(),
    health_report: input.healthReport,
  }, (query) =>
    query
      .eq("request_type", "demotion_review")
      .eq("agent_id", input.agentId)
      .eq("agent_version", input.version)
      .in("state", ["pending", "in_review"]),
  );
}

export async function enqueuePromotionReview(input: {
  promotionRequestId: number;
  agentId: string;
  version: string;
  targetTier: MarketplaceTrustTier;
  eligibilityReport?: Record<string, unknown>;
  db?: SupabaseClient | null;
}): Promise<ReviewQueueItem> {
  const db = input.db ?? getSupabase();
  if (!db) throw new Error("db_unavailable");
  return insertQueueRow(db, {
    request_type: "promotion",
    agent_id: input.agentId,
    agent_version: input.version,
    promotion_request_id: input.promotionRequestId,
    target_tier: input.targetTier,
    state: "pending",
    priority: input.targetTier === "official" ? "high" : "normal",
    sla_due_at: slaForTier(input.targetTier),
    eligibility_report: input.eligibilityReport ?? {},
  }, (query) => query.eq("promotion_request_id", input.promotionRequestId));
}

export async function enqueueIdentityVerificationReview(input: {
  userId: string;
  evidence?: Record<string, unknown>;
  db?: SupabaseClient | null;
}): Promise<ReviewQueueItem> {
  const db = input.db ?? getSupabase();
  if (!db) throw new Error("db_unavailable");
  const due = new Date();
  due.setDate(due.getDate() + 3);
  return insertQueueRow(db, {
    request_type: "identity_verification",
    identity_user_id: input.userId,
    state: "pending",
    priority: "normal",
    sla_due_at: due.toISOString(),
    eligibility_report: input.evidence ?? {},
  }, (query) =>
    query
      .eq("request_type", "identity_verification")
      .eq("identity_user_id", input.userId)
      .in("state", ["pending", "in_review"]),
  );
}

export async function listReviewQueue(input: {
  state?: ReviewQueueState | null;
  requestType?: ReviewRequestType | null;
  db?: SupabaseClient | null;
} = {}): Promise<ReviewQueueItem[]> {
  const db = input.db ?? getSupabase();
  if (!db) return [];
  let query = db
    .from("agent_review_queue")
    .select("*")
    .order("sla_due_at", { ascending: true })
    .limit(100);
  if (input.state) query = query.eq("state", input.state);
  if (input.requestType) query = query.eq("request_type", input.requestType);
  const { data, error } = await query;
  if (error) throw new Error(`review_queue_list_failed:${error.message}`);
  return (data ?? []) as ReviewQueueItem[];
}

async function insertQueueRow(
  db: SupabaseClient,
  row: Record<string, unknown>,
  existingQuery: (query: any) => any,
): Promise<ReviewQueueItem> {
  const { data, error } = await db
    .from("agent_review_queue")
    .insert(row)
    .select("*")
    .single();
  if (!error) return data as ReviewQueueItem;
  if (!/duplicate|unique/i.test(error.message)) {
    throw new Error(`review_queue_enqueue_failed:${error.message}`);
  }
  const { data: existing, error: existingError } = await existingQuery(
    db.from("agent_review_queue").select("*"),
  )
    .limit(1)
    .maybeSingle();
  if (existingError || !existing) {
    throw new Error(`review_queue_existing_lookup_failed:${existingError?.message ?? error.message}`);
  }
  return existing as ReviewQueueItem;
}

export async function getReviewQueueItem(
  id: string,
  db: SupabaseClient | null = getSupabase(),
): Promise<ReviewQueueItem | null> {
  if (!db) return null;
  const { data, error } = await db
    .from("agent_review_queue")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`review_queue_get_failed:${error.message}`);
  return (data as ReviewQueueItem | null) ?? null;
}

export async function recordReviewDecision(input: {
  queueId: string;
  reviewerId: string;
  reviewerEmail?: string | null;
  outcome: "approve" | "reject" | "needs_changes" | "withdraw";
  reasonCodes?: string[];
  notes?: string | null;
  evidence?: Record<string, unknown>;
  db?: SupabaseClient | null;
}): Promise<void> {
  const db = input.db ?? getSupabase();
  if (!db) throw new Error("db_unavailable");
  const nextState = outcomeToQueueState(input.outcome);
  const now = new Date().toISOString();
  const { error: decisionError } = await db.from("agent_review_decisions").insert({
    queue_id: input.queueId,
    reviewer_id: input.reviewerId,
    reviewer_email: input.reviewerEmail ?? null,
    outcome: input.outcome,
    reason_codes: input.reasonCodes ?? [],
    notes: input.notes ?? null,
    evidence: input.evidence ?? {},
    decided_at: now,
  });
  if (decisionError) throw new Error(`review_decision_insert_failed:${decisionError.message}`);

  const { data: queue, error: queueError } = await db
    .from("agent_review_queue")
    .update({
      state: nextState,
      decision_note: input.notes ?? null,
      decided_by: input.reviewerId,
      decided_at: now,
    })
    .eq("id", input.queueId)
    .select("*")
    .single();
  if (queueError) throw new Error(`review_queue_decision_failed:${queueError.message}`);

  await propagateDecision(queue as ReviewQueueItem, nextState, input, db);
}

function outcomeToQueueState(outcome: "approve" | "reject" | "needs_changes" | "withdraw"): ReviewQueueState {
  if (outcome === "approve") return "approved";
  if (outcome === "reject") return "rejected";
  if (outcome === "withdraw") return "withdrawn";
  return "needs_changes";
}

async function propagateDecision(
  queue: ReviewQueueItem,
  nextState: ReviewQueueState,
  input: {
    reviewerId: string;
    notes?: string | null;
    reasonCodes?: string[];
    evidence?: Record<string, unknown>;
  },
  db: SupabaseClient,
): Promise<void> {
  if (queue.request_type === "submission" && queue.agent_id && queue.agent_version) {
    const reviewState =
      nextState === "approved" ? "approved" : nextState === "needs_changes" ? "needs_changes" : "rejected";
    await db
      .from("marketplace_agent_versions")
      .update({
        review_state: reviewState,
        published_at: nextState === "approved" ? new Date().toISOString() : null,
      })
      .eq("agent_id", queue.agent_id)
      .eq("version", queue.agent_version);
    await db
      .from("marketplace_agents")
      .update(nextState === "approved"
        ? {
            state: "published",
            current_version: queue.agent_version,
            published_at: new Date().toISOString(),
          }
        : { state: "pending_review" })
      .eq("agent_id", queue.agent_id);
    await db.from("agent_security_reviews").upsert(
      {
        agent_id: queue.agent_id,
        agent_version: queue.agent_version,
        reviewer: input.reviewerId,
        outcome: reviewState,
        notes: input.notes ?? null,
        evidence: {
          reason_codes: input.reasonCodes ?? [],
          ...(input.evidence ?? {}),
        },
      },
      { onConflict: "agent_id,agent_version" },
    );
  }

  if (queue.request_type === "promotion" && queue.promotion_request_id) {
    await db
      .from("developer_promotion_requests")
      .update({
        state: nextState === "approved" ? "approved" : nextState === "needs_changes" ? "rejected" : nextState,
        decided_by: input.reviewerId,
        decided_at: new Date().toISOString(),
        decision_note: input.notes ?? null,
      })
      .eq("id", queue.promotion_request_id);
    if (nextState === "approved" && queue.agent_id && queue.target_tier) {
      await db
        .from("marketplace_agents")
        .update({ trust_tier: queue.target_tier })
        .eq("agent_id", queue.agent_id);
    }
  }

  if (queue.request_type === "identity_verification" && queue.identity_user_id) {
    await db
      .from("developer_identity_verifications")
      .update({
        review_state: nextState === "approved" ? "approved" : nextState === "needs_changes" ? "needs_changes" : "rejected",
        verification_tier: nextState === "approved" ? "legal_entity_verified" : "unverified",
        verifier: input.reviewerId,
        verified_at: nextState === "approved" ? new Date().toISOString() : null,
        rejection_reason: nextState === "approved" ? null : input.notes ?? "trust_review_rejected",
      })
      .eq("user_id", queue.identity_user_id);
  }
}
