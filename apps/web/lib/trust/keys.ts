import { createHash, createVerify } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../db.ts";

export interface DeveloperKeyRow {
  user_id: string;
  key_id: string;
  public_key_pem: string;
  public_key_jwk: Record<string, unknown> | null;
  algorithm: "ecdsa-p256";
  fingerprint_sha256: string;
  label: string | null;
  state: "active" | "revoked";
  registered_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface BundleSignatureInput {
  agentId: string;
  version: string;
  bundleSha256: string;
  signature: string;
  keyId: string;
  signerUserId?: string | null;
}

export function canonicalBundleSigningPayload(args: {
  agentId: string;
  version: string;
  bundleSha256: string;
}): string {
  return `lumo-agent-bundle:v1:${args.agentId}:${args.version}:${args.bundleSha256}`;
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem.replace(/\s+/g, "")).digest("hex");
}

export function keyIdForFingerprint(fingerprintSha256: string): string {
  return `p256:${fingerprintSha256.slice(0, 16)}`;
}

export async function registerDeveloperKey(input: {
  userId: string;
  keyId?: string | null;
  publicKeyPem: string;
  publicKeyJwk?: Record<string, unknown> | null;
  label?: string | null;
  db?: SupabaseClient | null;
}): Promise<DeveloperKeyRow> {
  const db = input.db ?? getSupabase();
  if (!db) throw new Error("db_unavailable");
  const fingerprint = fingerprintPublicKey(input.publicKeyPem);
  const keyId = input.keyId?.trim() || keyIdForFingerprint(fingerprint);
  if (!/^p256:[a-f0-9]{16}$/i.test(keyId) && !/^[a-zA-Z0-9:_-]{8,96}$/.test(keyId)) {
    throw new Error("invalid_key_id");
  }
  const row = {
    user_id: input.userId,
    key_id: keyId,
    public_key_pem: input.publicKeyPem,
    public_key_jwk: input.publicKeyJwk ?? null,
    algorithm: "ecdsa-p256",
    fingerprint_sha256: fingerprint,
    label: input.label?.trim() || null,
    state: "active",
    revoked_at: null,
  };
  const { data, error } = await db
    .from("developer_keys")
    .upsert(row, { onConflict: "user_id,key_id" })
    .select("*")
    .single();
  if (error) throw new Error(`developer_key_register_failed:${error.message}`);
  return data as DeveloperKeyRow;
}

export async function verifyBundleSignature(
  input: BundleSignatureInput & { db?: SupabaseClient | null },
): Promise<{ ok: true; key: DeveloperKeyRow } | { ok: false; error: string }> {
  const db = input.db ?? getSupabase();
  if (!db) return { ok: false, error: "db_unavailable" };
  let query = db
    .from("developer_keys")
    .select("*")
    .eq("key_id", input.keyId)
    .eq("state", "active")
    .limit(1);
  if (input.signerUserId) query = query.eq("user_id", input.signerUserId);

  const { data, error } = await query;
  if (error) return { ok: false, error: `developer_key_lookup_failed:${error.message}` };
  const key = (data?.[0] ?? null) as DeveloperKeyRow | null;
  if (!key) return { ok: false, error: "active_key_not_found" };

  const verifier = createVerify("sha256");
  verifier.update(canonicalBundleSigningPayload(input));
  verifier.end();
  let verified = false;
  try {
    verified = verifier.verify(key.public_key_pem, Buffer.from(input.signature, "base64url"));
  } catch {
    return { ok: false, error: "signature_decode_failed" };
  }
  if (!verified) return { ok: false, error: "signature_invalid" };

  await db
    .from("developer_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("user_id", key.user_id)
    .eq("key_id", key.key_id);

  return { ok: true, key };
}

export async function revokeDeveloperKey(input: {
  userId: string;
  keyId: string;
  revokedBy?: string | null;
  reason: string;
  db?: SupabaseClient | null;
}): Promise<{ key_id: string; versions_yanked: number }> {
  const db = input.db ?? getSupabase();
  if (!db) throw new Error("db_unavailable");
  const now = new Date().toISOString();

  const { data: versions } = await db
    .from("marketplace_agent_versions")
    .select("agent_id, version")
    .eq("signer_user_id", input.userId)
    .eq("signing_key_id", input.keyId)
    .eq("yanked", false);
  const affected = (versions ?? []) as Array<{ agent_id: string; version: string }>;

  const { error: keyError } = await db
    .from("developer_keys")
    .update({ state: "revoked", revoked_at: now })
    .eq("user_id", input.userId)
    .eq("key_id", input.keyId)
    .eq("state", "active");
  if (keyError) throw new Error(`developer_key_revoke_failed:${keyError.message}`);

  if (affected.length > 0) {
    const pairs = affected.map((v) => `(${v.agent_id},${v.version})`).join(",");
    for (const version of affected) {
      await db
        .from("marketplace_agent_versions")
        .update({
          yanked: true,
          yanked_at: now,
          yanked_reason: "developer_key_revoked",
          review_state: "rejected",
        })
        .eq("agent_id", version.agent_id)
        .eq("version", version.version);
    }
    console.info(`[trust] revoked key ${input.keyId}; yanked versions ${pairs}`);
  }

  const { error: revokeError } = await db.from("developer_key_revocations").insert({
    user_id: input.userId,
    key_id: input.keyId,
    revoked_by: input.revokedBy ?? input.userId,
    reason: input.reason,
    versions_yanked: affected.length,
    evidence: { source: "trust_1" },
  });
  if (revokeError) throw new Error(`developer_key_revocation_log_failed:${revokeError.message}`);

  return { key_id: input.keyId, versions_yanked: affected.length };
}
