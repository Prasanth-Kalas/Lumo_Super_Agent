/**
 * Marketplace submission pipeline.
 *
 * This is the backend equivalent of `lumo-agent submit`: parse + validate the
 * manifest, check typosquatting, store the bundle, then upsert catalog and
 * version rows. TRUST-1 later replaces the review stub; MARKETPLACE-1 owns the
 * durable distribution substrate.
 */

import { parseManifest, type AgentManifest } from "@lumo/agent-sdk";
import { ensureRegistry } from "../agent-registry.js";
import { getSupabase } from "../db.js";
import type { MarketplaceTrustTier } from "../marketplace.js";
import { storeAgentBundle } from "./bundle-store.js";
import { verifyBundleSignature } from "../trust/keys.js";
import {
  checkTyposquat,
  type ProtectedAgentId,
  type TyposquatResult,
} from "./typosquatting.js";
import { signatureRequirementError } from "./submission-policy.js";
import { runChecks } from "../trust/check-pipeline.js";
import { enqueueSubmissionReview } from "../trust/queue.js";

export interface SubmitMarketplaceAgentInput {
  manifest: unknown;
  bundleBytes: Uint8Array;
  authorUserId?: string | null;
  authorEmail: string;
  authorName?: string | null;
  requestedTier?: MarketplaceTrustTier;
  signature?: string | null;
  signingKeyId?: string | null;
}

export interface MarketplaceSubmissionResult {
  agent_id: string;
  version: string;
  state: "pending_review" | "published";
  review_state: "pending_review" | "automated_passed" | "approved" | "rejected";
  trust_tier: MarketplaceTrustTier;
  bundle_path: string;
  bundle_sha256: string;
  bundle_size_bytes: number;
  signature_verified: boolean;
  automated_checks: unknown;
  status_url: string;
}

export async function submitMarketplaceAgent(
  input: SubmitMarketplaceAgentInput,
): Promise<MarketplaceSubmissionResult> {
  const manifest = parseManifest(input.manifest);
  const trustTier = input.requestedTier ?? requestedTierFromManifest(manifest);
  const signatureError = signatureRequirementError(trustTier, input.signature, input.signingKeyId);
  if (signatureError) {
    throw new MarketplaceSubmissionError(signatureError, { trust_tier: trustTier });
  }
  const protectedIds = await listProtectedAgentIds();
  const typo = checkTyposquat(manifest.agent_id, protectedIds);
  if (!typo.ok) {
    throw new MarketplaceSubmissionError("typosquat_rejected", typo);
  }

  const db = getSupabase();
  if (!db) throw new MarketplaceSubmissionError("db_unavailable");

  const stored = await storeAgentBundle({
    agentId: manifest.agent_id,
    version: manifest.version,
    bytes: input.bundleBytes,
  });
  let signatureVerified = false;
  let signatureVerificationError: string | null = null;
  if (input.signature?.trim() || input.signingKeyId?.trim()) {
    if (!input.signature?.trim()) {
      throw new MarketplaceSubmissionError("signature_required");
    }
    if (!input.signingKeyId?.trim()) {
      throw new MarketplaceSubmissionError("signing_key_required");
    }
    const verification = await verifyBundleSignature({
      db,
      agentId: manifest.agent_id,
      version: manifest.version,
      bundleSha256: stored.sha256,
      signature: input.signature,
      keyId: input.signingKeyId,
      signerUserId: input.authorUserId ?? null,
    });
    if (!verification.ok) {
      if (trustTier === "official" || trustTier === "verified") {
        throw new MarketplaceSubmissionError("signature_invalid", { reason: verification.error });
      }
      signatureVerificationError = verification.error;
    } else {
      signatureVerified = true;
    }
  }
  const now = new Date().toISOString();
  const state = "pending_review";
  const reviewState = "pending_review";
  const category = categoryFromManifest(manifest);

  // TRUST-1 owns static analysis, malware scanning, and signature verification
  // before a submitted bundle can move beyond pending_review.
  const { error: agentError } = await db.from("marketplace_agents").upsert(
    {
      agent_id: manifest.agent_id,
      current_version: manifest.version,
      trust_tier: trustTier,
      state,
      manifest,
      category,
      bundle_path: stored.path,
      bundle_sha256: stored.sha256,
      author_email: input.authorEmail.toLowerCase(),
      author_name: input.authorName ?? input.authorEmail,
      author_url: safeStringAt(manifest, ["author", "url"]),
      homepage: safeStringAt(manifest, ["listing", "homepage"]) ?? safeStringAt(manifest, ["homepage"]),
      privacy_url: safeStringAt(manifest, ["listing", "privacy_url"]) ?? safeStringAt(manifest, ["privacy_url"]),
      support_url: safeStringAt(manifest, ["listing", "support_url"]) ?? safeStringAt(manifest, ["support_url"]),
      data_retention_policy: safeStringAt(manifest, ["data_retention_policy"]),
      tags: tagsFromManifest(manifest),
      published_at: null,
      updated_at: now,
    },
    { onConflict: "agent_id" },
  );
  if (agentError) {
    throw new MarketplaceSubmissionError("marketplace_agent_upsert_failed", {
      message: agentError.message,
    });
  }

  const { error: versionError } = await db.from("marketplace_agent_versions").upsert(
    {
      agent_id: manifest.agent_id,
      version: manifest.version,
      manifest,
      bundle_path: stored.path,
      bundle_sha256: stored.sha256,
      bundle_size_bytes: stored.sizeBytes,
      signature: input.signature ?? null,
      signature_verified: signatureVerified,
      signer_user_id: signatureVerified ? (input.authorUserId ?? null) : null,
      signing_key_id: signatureVerified ? (input.signingKeyId ?? null) : null,
      signature_algorithm: "ecdsa-p256",
      signature_verified_at: signatureVerified ? now : null,
      signature_verification_error: signatureVerificationError,
      review_state: reviewState,
      published_at: null,
      updated_at: now,
      yanked: false,
      yanked_reason: null,
      yanked_at: null,
    },
    { onConflict: "agent_id,version" },
  );
  if (versionError) {
    throw new MarketplaceSubmissionError("marketplace_version_upsert_failed", {
      message: versionError.message,
    });
  }

  const checkReport = await runChecks({
    agentId: manifest.agent_id,
    agentVersion: manifest.version,
    manifest,
    bundleBytes: input.bundleBytes,
  });

  let finalState: "pending_review" | "published" = "pending_review";
  let finalReviewState: "automated_passed" | "approved" | "rejected" =
    checkReport.passed ? "automated_passed" : "rejected";
  if (!checkReport.passed) {
    await db
      .from("marketplace_agent_versions")
      .update({ review_state: "rejected", updated_at: new Date().toISOString() })
      .eq("agent_id", manifest.agent_id)
      .eq("version", manifest.version);
  } else if (trustTier === "experimental") {
    finalState = "published";
    finalReviewState = "approved";
    const publishedNow = new Date().toISOString();
    await db
      .from("marketplace_agent_versions")
      .update({
        review_state: "approved",
        published_at: publishedNow,
        updated_at: publishedNow,
      })
      .eq("agent_id", manifest.agent_id)
      .eq("version", manifest.version);
    await db
      .from("marketplace_agents")
      .update({
        state: "published",
        current_version: manifest.version,
        published_at: publishedNow,
        updated_at: publishedNow,
      })
      .eq("agent_id", manifest.agent_id);
  } else {
    await db
      .from("marketplace_agent_versions")
      .update({ review_state: "automated_passed", updated_at: new Date().toISOString() })
      .eq("agent_id", manifest.agent_id)
      .eq("version", manifest.version);
    await enqueueSubmissionReview({
      db,
      agentId: manifest.agent_id,
      version: manifest.version,
      targetTier: trustTier,
      automatedChecks: checkReport as unknown as Record<string, unknown>,
    });
  }

  return {
    agent_id: manifest.agent_id,
    version: manifest.version,
    state: finalState,
    review_state: finalReviewState,
    trust_tier: trustTier,
    bundle_path: stored.path,
    bundle_sha256: stored.sha256,
    bundle_size_bytes: stored.sizeBytes,
    signature_verified: signatureVerified,
    automated_checks: checkReport,
    status_url: `/api/marketplace/submissions/${encodeURIComponent(manifest.agent_id)}/status?version=${encodeURIComponent(manifest.version)}`,
  };
}

export async function marketplaceSubmissionStatus(
  agentId: string,
  version?: string | null,
): Promise<{
  agent_id: string;
  state: string;
  trust_tier: string;
  current_version: string | null;
  version: string | null;
  review_state: string | null;
  submitted_at: string | null;
  published_at: string | null;
  yanked: boolean;
} | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data: agent, error: agentError } = await db
    .from("marketplace_agents")
    .select("agent_id, state, trust_tier, current_version")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (agentError || !agent) return null;

  let versionQuery = db
    .from("marketplace_agent_versions")
    .select("version, review_state, submitted_at, published_at, yanked")
    .eq("agent_id", agentId)
    .order("submitted_at", { ascending: false })
    .limit(1);
  if (version) versionQuery = versionQuery.eq("version", version);
  const { data: versions } = await versionQuery;
  const v = versions?.[0] as
    | {
        version: string;
        review_state: string;
        submitted_at: string;
        published_at: string | null;
        yanked: boolean;
      }
    | undefined;

  return {
    agent_id: String((agent as { agent_id: string }).agent_id),
    state: String((agent as { state: string }).state),
    trust_tier: String((agent as { trust_tier: string }).trust_tier),
    current_version: ((agent as { current_version?: string | null }).current_version ?? null),
    version: v?.version ?? null,
    review_state: v?.review_state ?? null,
    submitted_at: v?.submitted_at ?? null,
    published_at: v?.published_at ?? null,
    yanked: v?.yanked === true,
  };
}

export class MarketplaceSubmissionError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, detail?: unknown) {
    super(code);
    this.name = "MarketplaceSubmissionError";
    this.code = code;
    this.detail = detail;
  }
}

async function listProtectedAgentIds(): Promise<ProtectedAgentId[]> {
  const db = getSupabase();
  const protectedIds: ProtectedAgentId[] = [];

  if (db) {
    const { data, error } = await db
      .from("marketplace_agents")
      .select("agent_id, trust_tier")
      .in("trust_tier", ["official", "verified"]);
    if (!error) {
      protectedIds.push(
        ...((data ?? []) as Array<{ agent_id: string; trust_tier: MarketplaceTrustTier }>),
      );
    }
  }

  try {
    const registry = await ensureRegistry();
    for (const entry of Object.values(registry.agents)) {
      protectedIds.push({
        agent_id: entry.manifest.agent_id,
        trust_tier: "official",
      });
    }
  } catch {
    // A registry load failure should not make submission impossible if DB is up.
  }

  return protectedIds;
}

function requestedTierFromManifest(manifest: AgentManifest): MarketplaceTrustTier {
  const record = manifest as AgentManifest & Record<string, unknown>;
  const tier = record.trust_tier ?? record.marketplace_tier;
  if (
    tier === "official" ||
    tier === "verified" ||
    tier === "community" ||
    tier === "experimental"
  ) {
    return tier;
  }
  return "experimental";
}

function categoryFromManifest(manifest: AgentManifest): string {
  const category = manifest.listing?.category ?? manifest.domain ?? "Other";
  return category.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "other";
}

function tagsFromManifest(manifest: AgentManifest): string[] {
  const record = manifest as AgentManifest & Record<string, unknown>;
  const raw = record.tags ?? record.intent_tags ?? manifest.intents;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 24);
}

function safeStringAt(value: unknown, path: string[]): string | null {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : null;
}
