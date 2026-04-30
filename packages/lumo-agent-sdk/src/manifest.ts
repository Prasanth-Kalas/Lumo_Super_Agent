const MERCHANT_PROVIDERS = new Set([
  "duffel",
  "booking",
  "expedia_partner_solutions",
  "uber_for_business",
  "stripe_issuing",
  "stripe_payments",
  "mock_merchant",
]);

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateMerchantManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (!isRecord(manifest)) return { ok: false, errors: ["manifest must be an object"] };

  const agentClass = manifest.agent_class ?? "oauth_as_user";
  if (agentClass !== "merchant_of_record") return { ok: true, errors };

  if (typeof manifest.commerce !== "object" || manifest.commerce === null) {
    errors.push("merchant_of_record manifest requires commerce block");
  }
  const provider = manifest.merchant_provider;
  if (typeof provider !== "string" || !MERCHANT_PROVIDERS.has(provider)) {
    errors.push("merchant_provider must be an allowlisted provider");
  }
  if (!Array.isArray(manifest.transaction_capabilities)) {
    errors.push("transaction_capabilities must be an array");
  } else {
    const ids = new Set<string>();
    const compensationTargets = new Set<string>();
    for (const [index, capability] of manifest.transaction_capabilities.entries()) {
      if (!isRecord(capability)) {
        errors.push(`transaction_capabilities[${index}] must be an object`);
        continue;
      }
      const id = capability.id;
      if (typeof id !== "string" || id.length === 0) {
        errors.push(`transaction_capabilities[${index}].id is required`);
      } else if (ids.has(id)) {
        errors.push(`transaction_capabilities duplicate id ${id}`);
      } else {
        ids.add(id);
      }
      const compensationAction = capability.compensationAction;
      if (typeof compensationAction === "string" && compensationAction.length > 0) {
        compensationTargets.add(compensationAction);
      }
      const legacyCompensation = capability.compensation_action_capability_id;
      if (typeof legacyCompensation === "string" && legacyCompensation.length > 0) {
        compensationTargets.add(legacyCompensation);
      }
      if (capability.requires_confirmation !== true) {
        errors.push(`transaction_capabilities[${index}].requires_confirmation must be true`);
      }
      if (typeof capability.idempotency_key_field !== "string") {
        errors.push(`transaction_capabilities[${index}].idempotency_key_field is required`);
      }
      const max = capability.max_single_transaction_amount;
      if (!isRecord(max) || max.currency !== "USD" || typeof max.amount !== "number" || max.amount <= 0) {
        errors.push(`transaction_capabilities[${index}].max_single_transaction_amount must be positive USD`);
      }
    }

    for (const [index, capability] of manifest.transaction_capabilities.entries()) {
      if (!isRecord(capability)) continue;
      const kind = typeof capability.kind === "string" ? capability.kind : "";
      const id = typeof capability.id === "string" ? capability.id : "";
      const isCompensationTarget = compensationTargets.has(id);
      if (
        /^(book_|hold_|change_|cancel_|capture_|create_payment)/.test(kind) &&
        !isCompensationTarget &&
        typeof capability.compensationAction !== "string"
      ) {
        errors.push(`transaction_capabilities[${index}] requires compensationAction`);
      }
      const target = capability.compensationAction;
      if (
        typeof target === "string" &&
        target.length > 0 &&
        target !== "manual_review" &&
        !ids.has(target) &&
        !manifestDeclaresCapability(manifest, target)
      ) {
        errors.push(`transaction_capabilities[${index}].compensationAction must reference another transaction capability`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidMerchantManifest(manifest: unknown): void {
  const result = validateMerchantManifest(manifest);
  if (!result.ok) throw new Error(`merchant_manifest_invalid:${result.errors.join(";")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestDeclaresCapability(
  manifest: Record<string, unknown>,
  capabilityId: string,
): boolean {
  const capabilities = manifest.capabilities;
  if (Array.isArray(capabilities) && capabilities.includes(capabilityId)) return true;
  if (isRecord(capabilities) && capabilityId in capabilities) return true;
  const intents = manifest.intents;
  return Array.isArray(intents) && intents.includes(capabilityId);
}
