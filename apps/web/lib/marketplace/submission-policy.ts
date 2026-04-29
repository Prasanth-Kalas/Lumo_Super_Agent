import type { MarketplaceTrustTier } from "../marketplace.js";

export function signatureRequirementError(
  trustTier: MarketplaceTrustTier,
  signature: string | null | undefined,
): "signature_required" | null {
  if ((trustTier === "official" || trustTier === "verified") && !signature?.trim()) {
    return "signature_required";
  }
  return null;
}
