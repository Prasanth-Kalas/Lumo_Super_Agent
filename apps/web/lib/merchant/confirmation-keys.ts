import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/db";
import {
  decodeBase64Signature,
  fingerprintConfirmationPublicKey,
  hashSignedConfirmationToken,
  normalizeTransactionDigestHex,
  verifyDigestSignature,
} from "@/lib/merchant/confirmation-crypto";

export type ConfirmationKeyErrorCode =
  | "db_unavailable"
  | "invalid_device_id"
  | "invalid_public_key"
  | "invalid_transaction_digest"
  | "invalid_confirmation_token"
  | "confirmation_key_not_found"
  | "confirmation_signature_invalid"
  | "confirmation_key_register_failed";

export class ConfirmationKeyError extends Error {
  readonly code: ConfirmationKeyErrorCode;
  readonly status: number;

  constructor(code: ConfirmationKeyErrorCode, message: string, status = 400) {
    super(message);
    this.name = "ConfirmationKeyError";
    this.code = code;
    this.status = status;
  }
}

export interface ConfirmationKeyRow {
  id: string;
  user_id: string;
  device_id: string;
  public_key_pem: string;
  public_key_fingerprint: string;
  algorithm: "ecdsa-p256";
  state: "active" | "revoked";
  last_used_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
  updated_at: string;
}

function dbOrThrow(db?: SupabaseClient | null): SupabaseClient {
  const client = db ?? getSupabase();
  if (!client) {
    throw new ConfirmationKeyError(
      "db_unavailable",
      "Merchant confirmation-key persistence is unavailable.",
      503,
    );
  }
  return client;
}

export { fingerprintConfirmationPublicKey, hashSignedConfirmationToken };

export function assertTransactionDigestHex(digest: string): string {
  const normalized = normalizeTransactionDigestHex(digest);
  if (!normalized) {
    throw new ConfirmationKeyError(
      "invalid_transaction_digest",
      "transactionDigest must be a 64-character hex SHA-256 digest",
      400,
    );
  }
  return normalized;
}

export function decodeSignedConfirmationToken(signedTokenBase64: string): Buffer {
  const decoded = decodeBase64Signature(signedTokenBase64);
  if (!decoded) {
    throw new ConfirmationKeyError(
      "invalid_confirmation_token",
      "signedConfirmationToken must be valid base64",
      400,
    );
  }
  return decoded;
}

export async function registerDeviceKey(input: {
  userId: string;
  deviceId: string;
  publicKeyPem: string;
  db?: SupabaseClient | null;
}): Promise<ConfirmationKeyRow> {
  const deviceId = input.deviceId.trim();
  if (deviceId.length < 8 || deviceId.length > 160) {
    throw new ConfirmationKeyError("invalid_device_id", "deviceId length is invalid", 400);
  }
  const publicKeyPem = input.publicKeyPem.trim();
  if (!publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")) {
    throw new ConfirmationKeyError(
      "invalid_public_key",
      "publicKeyPem must be an SPKI PEM public key",
      400,
    );
  }

  const db = dbOrThrow(input.db);
  const now = new Date().toISOString();
  const row = {
    user_id: input.userId,
    device_id: deviceId,
    public_key_pem: publicKeyPem,
    public_key_fingerprint: fingerprintConfirmationPublicKey(publicKeyPem),
    algorithm: "ecdsa-p256" as const,
    state: "active" as const,
    revoked_at: null,
    revoke_reason: null,
    updated_at: now,
  };

  const { data, error } = await db
    .from("confirmation_keys")
    .upsert(row, { onConflict: "user_id,device_id" })
    .select("*")
    .single();
  if (error) {
    throw new ConfirmationKeyError(
      "confirmation_key_register_failed",
      error.message,
      500,
    );
  }
  return data as ConfirmationKeyRow;
}

export async function verifyConfirmationToken(input: {
  userId: string;
  deviceId?: string | null;
  transactionDigest: string;
  signedTokenBase64: string;
  db?: SupabaseClient | null;
}): Promise<{ ok: true; key: ConfirmationKeyRow; tokenHash: string } | { ok: false; error: ConfirmationKeyErrorCode }> {
  const db = dbOrThrow(input.db);
  const digest = assertTransactionDigestHex(input.transactionDigest);
  decodeSignedConfirmationToken(input.signedTokenBase64);

  let query = db
    .from("confirmation_keys")
    .select("*")
    .eq("user_id", input.userId)
    .eq("state", "active")
    .order("created_at", { ascending: false })
    .limit(input.deviceId ? 1 : 10);
  if (input.deviceId) query = query.eq("device_id", input.deviceId);

  const { data, error } = await query;
  if (error) {
    throw new ConfirmationKeyError("confirmation_key_not_found", error.message, 500);
  }
  const keys = (data ?? []) as ConfirmationKeyRow[];
  if (keys.length === 0) return { ok: false, error: "confirmation_key_not_found" };

  for (const key of keys) {
    if (
      verifyDigestSignature({
        publicKeyPem: key.public_key_pem,
        transactionDigestHex: digest,
        signatureBase64: input.signedTokenBase64,
      })
    ) {
      await db
        .from("confirmation_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", key.id);
      return {
        ok: true,
        key,
        tokenHash: hashSignedConfirmationToken(input.signedTokenBase64),
      };
    }
  }

  return { ok: false, error: "confirmation_signature_invalid" };
}
