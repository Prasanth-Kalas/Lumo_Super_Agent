/**
 * Bundle storage helpers for marketplace submissions.
 *
 * V1 stores bundles in Supabase Storage. Object-lock is declared in the
 * infra bucket file; this helper is intentionally small and hash-first so
 * download routes can verify bytes before serving them.
 */

import { createHash } from "node:crypto";
import { getSupabase } from "../db.js";
import { verifyBundleSignature } from "../trust/keys.js";

export const AGENT_BUNDLE_BUCKET = "agent-bundles";

export interface StoredBundle {
  bucket: typeof AGENT_BUNDLE_BUCKET;
  path: string;
  sha256: string;
  sizeBytes: number;
}

export function marketplaceBundlePath(agentId: string, version: string): string {
  return `${safePathPart(agentId)}/${safePathPart(version)}/bundle.tar.gz`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function storeAgentBundle(args: {
  agentId: string;
  version: string;
  bytes: Uint8Array;
  contentType?: string;
}): Promise<StoredBundle> {
  const db = getSupabase();
  if (!db) throw new Error("bundle_storage_unavailable");

  const path = marketplaceBundlePath(args.agentId, args.version);
  const sha256 = sha256Hex(args.bytes);
  const { error } = await db.storage
    .from(AGENT_BUNDLE_BUCKET)
    .upload(path, Buffer.from(args.bytes), {
      contentType: args.contentType ?? "application/gzip",
      upsert: false,
    });

  if (error && !alreadyExists(error.message)) {
    throw new Error(`bundle_upload_failed:${error.message}`);
  }

  return {
    bucket: AGENT_BUNDLE_BUCKET,
    path,
    sha256,
    sizeBytes: args.bytes.byteLength,
  };
}

export async function downloadVerifiedBundle(args: {
  path: string;
  expectedSha256: string;
  agentId?: string;
  version?: string;
  signature?: string | null;
  signingKeyId?: string | null;
  signerUserId?: string | null;
}): Promise<{ bytes: Uint8Array; sha256: string }> {
  const db = getSupabase();
  if (!db) throw new Error("bundle_storage_unavailable");

  const { data, error } = await db.storage.from(AGENT_BUNDLE_BUCKET).download(args.path);
  if (error) throw new Error(`bundle_download_failed:${error.message}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  const sha256 = sha256Hex(bytes);
  if (sha256 !== args.expectedSha256) {
    throw new Error("bundle_sha256_mismatch");
  }
  if (args.signature && args.signingKeyId && args.agentId && args.version) {
    const signature = await verifyBundleSignature({
      db,
      agentId: args.agentId,
      version: args.version,
      bundleSha256: sha256,
      signature: args.signature,
      keyId: args.signingKeyId,
      signerUserId: args.signerUserId ?? null,
    });
    if (!signature.ok) {
      throw new Error(`bundle_signature_invalid:${signature.error}`);
    }
  }
  return { bytes, sha256 };
}

function safePathPart(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$/.test(normalized)) {
    throw new Error(`invalid_bundle_path_part:${value}`);
  }
  return normalized;
}

function alreadyExists(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("already exists") || m.includes("duplicate");
}
