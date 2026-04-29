import type { AgentManifest } from "@lumo/agent-sdk";
import type { SandboxRunResult, TrustCheckResult } from "./types.ts";
import { result, trustFixture } from "./types.ts";

export async function runSandboxCheck(manifest: AgentManifest, rawManifest: unknown = manifest): Promise<{
  check: TrustCheckResult;
  sandbox: SandboxRunResult;
}> {
  const startedAt = new Date().toISOString();
  const fixture = trustFixture(rawManifest);
  const forcedFailure = fixture.sandbox_fail === true;
  const touchedScopes = Array.isArray(fixture.touched_scopes)
    ? fixture.touched_scopes.filter((s): s is string => typeof s === "string")
    : [];
  const capabilityResults = capabilityIds(manifest).map((capability_id) => ({
    capability_id,
    outcome: forcedFailure ? "fail" as const : "pass" as const,
    cost_usd: 0,
    error: forcedFailure ? "forced_trust_fixture_failure" : undefined,
  }));
  const sandbox: SandboxRunResult = {
    passed: !forcedFailure,
    touched_scopes: touchedScopes,
    capability_results: capabilityResults,
    logs: forcedFailure ? ["Synthetic sandbox run failed from x_trust fixture."] : ["Synthetic sandbox run completed."],
  };
  return {
    sandbox,
    check: result({
      id: "sandbox",
      label: "E2B sandbox test run",
      outcome: sandbox.passed ? "pass" : "fail",
      reason_codes: sandbox.passed ? [] : ["sandbox_test_failed"],
      startedAt,
      details: sandbox as unknown as Record<string, unknown>,
    }),
  };
}

function capabilityIds(manifest: AgentManifest): string[] {
  const record = manifest as AgentManifest & Record<string, unknown>;
  const raw = record.capabilities;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const list = (raw as Record<string, unknown>).tools;
    if (Array.isArray(list)) {
      const ids = list
        .map((item) => typeof item === "string" ? item : null)
        .filter((item): item is string => item !== null);
      if (ids.length > 0) return ids;
    }
  }
  return manifest.intents.length > 0 ? manifest.intents : ["default"];
}
