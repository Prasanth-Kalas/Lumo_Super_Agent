import { readFileSync } from "node:fs";
import { parseManifest, type AgentManifest } from "@lumo/agent-sdk";
import type { SampleManifestExtension } from "./runtime.ts";

export interface SampleManifestValidation {
  manifest: AgentManifest;
  extension: SampleManifestExtension;
  errors: string[];
}

const TRUST_TIERS = new Set(["experimental", "verified", "official"]);
const RUNTIMES = new Set(["node18", "e2b"]);

export function validateSampleManifestFile(path: string): SampleManifestValidation {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const errors: string[] = [];
  let manifest: AgentManifest;
  try {
    manifest = parseManifest(raw);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    manifest = {} as AgentManifest;
  }

  const extension = raw.x_lumo_sample as SampleManifestExtension | undefined;
  if (!extension || typeof extension !== "object") {
    errors.push("x_lumo_sample is required for reference agents");
  } else {
    if (!TRUST_TIERS.has(extension.trust_tier_target)) {
      errors.push("x_lumo_sample.trust_tier_target is invalid");
    }
    if (!RUNTIMES.has(extension.runtime)) {
      errors.push("x_lumo_sample.runtime is invalid");
    }
    if (!Array.isArray(extension.requires?.brain_tools)) {
      errors.push("x_lumo_sample.requires.brain_tools must be an array");
    }
    if (!Array.isArray(extension.requires?.connectors)) {
      errors.push("x_lumo_sample.requires.connectors must be an array");
    }
    if (!Array.isArray(extension.requires?.scopes)) {
      errors.push("x_lumo_sample.requires.scopes must be an array");
    }
    const maxCost = extension.cost_model?.max_cost_usd_per_invocation;
    if (typeof maxCost !== "number" || maxCost <= 0) {
      errors.push("x_lumo_sample.cost_model.max_cost_usd_per_invocation must be positive");
    }
  }

  return {
    manifest,
    extension: extension ?? {
      trust_tier_target: "experimental",
      runtime: "e2b",
      requires: { brain_tools: [], connectors: [], scopes: [] },
      cost_model: { max_cost_usd_per_invocation: 0 },
    },
    errors,
  };
}

export function assertCostWithinManifest(
  validation: SampleManifestValidation,
  actualUsd: number,
): void {
  const maxUsd = validation.extension.cost_model.max_cost_usd_per_invocation;
  if (actualUsd > maxUsd) {
    throw new Error(
      `${validation.manifest.agent_id} spent ${actualUsd}, above manifest ceiling ${maxUsd}`,
    );
  }
}
