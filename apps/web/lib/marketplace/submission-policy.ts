import type { MarketplaceTrustTier } from "../marketplace.js";

export function signatureRequirementError(
  trustTier: MarketplaceTrustTier,
  signature: string | null | undefined,
  keyId?: string | null | undefined,
): "signature_required" | "signing_key_required" | null {
  if ((trustTier === "official" || trustTier === "verified") && !signature?.trim()) {
    return "signature_required";
  }
  if ((trustTier === "official" || trustTier === "verified") && !keyId?.trim()) {
    return "signing_key_required";
  }
  return null;
}
