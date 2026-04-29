import { createHash, createVerify } from "node:crypto";

export function normalizeTransactionDigestHex(digest: string): string | null {
  const normalized = digest.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

export function decodeBase64Signature(signatureBase64: string): Buffer | null {
  if (!signatureBase64 || signatureBase64.length < 16) return null;
  try {
    const decoded = Buffer.from(signatureBase64, "base64");
    return decoded.length >= 16 ? decoded : null;
  } catch {
    return null;
  }
}

export function fingerprintConfirmationPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem.replace(/\s+/g, "")).digest("hex");
}

export function hashSignedConfirmationToken(signedTokenBase64: string): string {
  return createHash("sha256").update(signedTokenBase64).digest("hex");
}

export function verifyDigestSignature(input: {
  publicKeyPem: string;
  transactionDigestHex: string;
  signatureBase64: string;
}): boolean {
  const digest = normalizeTransactionDigestHex(input.transactionDigestHex);
  const signature = decodeBase64Signature(input.signatureBase64);
  if (!digest || !signature) return false;

  const verifier = createVerify("sha256");
  verifier.update(Buffer.from(digest, "hex"));
  verifier.end();
  try {
    return verifier.verify(input.publicKeyPem, signature);
  } catch {
    return false;
  }
}
