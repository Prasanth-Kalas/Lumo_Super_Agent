import type { AgentManifest } from "@lumo/agent-sdk";

export type TrustCheckId = "manifest" | "cve" | "static" | "sandbox" | "fingerprint";
export type TrustCheckOutcome = "pass" | "warn" | "fail";

export interface TrustCheckResult {
  id: TrustCheckId;
  label: string;
  outcome: TrustCheckOutcome;
  reason_codes: string[];
  details: Record<string, unknown>;
  started_at: string;
  completed_at: string;
}

export interface TrustCheckContext {
  agentId: string;
  version: string;
  manifestRaw: unknown;
  manifest?: AgentManifest;
  bundleBytes?: Uint8Array | null;
}

export interface SandboxRunResult {
  passed: boolean;
  touched_scopes: string[];
  capability_results: Array<{
    capability_id: string;
    outcome: "pass" | "fail";
    cost_usd?: number;
    error?: string;
  }>;
  logs: string[];
}

export function result(args: {
  id: TrustCheckId;
  label: string;
  outcome: TrustCheckOutcome;
  reason_codes?: string[];
  details?: Record<string, unknown>;
  startedAt?: string;
}): TrustCheckResult {
  const now = new Date().toISOString();
  return {
    id: args.id,
    label: args.label,
    outcome: args.outcome,
    reason_codes: args.reason_codes ?? [],
    details: args.details ?? {},
    started_at: args.startedAt ?? now,
    completed_at: now,
  };
}

export function declaredScopes(manifest: AgentManifest | Record<string, unknown>): string[] {
  const record = manifest as Record<string, unknown>;
  const direct = record.requires;
  const sample = record.x_lumo_sample;
  const trust = record.x_trust;
  const sources = [direct, isRecord(sample) ? sample.requires : null, trust];
  const scopes = new Set<string>();
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const raw = source.scopes;
    if (Array.isArray(raw)) {
      for (const scope of raw) {
        if (typeof scope === "string" && scope.trim()) scopes.add(scope.trim());
      }
    }
  }
  return [...scopes].sort();
}

export function manifestDependencies(manifest: AgentManifest | Record<string, unknown>): Array<{
  name: string;
  version: string;
  ecosystem: "npm";
}> {
  const record = manifest as Record<string, unknown>;
  const raw = record.dependencies ?? (isRecord(record.x_trust) ? record.x_trust.dependencies : null);
  const out: Array<{ name: string; version: string; ecosystem: "npm" }> = [];
  if (Array.isArray(raw)) {
    for (const dep of raw) {
      if (!isRecord(dep)) continue;
      const name = typeof dep.name === "string" ? dep.name.trim() : "";
      const version = typeof dep.version === "string" ? dep.version.trim() : "";
      if (name && version) out.push({ name, version, ecosystem: "npm" });
    }
  } else if (isRecord(raw)) {
    for (const [name, version] of Object.entries(raw)) {
      if (typeof version === "string" && name.trim() && version.trim()) {
        out.push({ name: name.trim(), version: version.trim(), ecosystem: "npm" });
      }
    }
  }
  return out;
}

export function trustFixture(manifest: unknown): Record<string, unknown> {
  if (!isRecord(manifest)) return {};
  const raw = manifest.x_trust;
  return isRecord(raw) ? raw : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
