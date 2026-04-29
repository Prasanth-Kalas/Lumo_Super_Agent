import type { AgentManifest } from "@lumo/agent-sdk";
import type { SandboxRunResult, TrustCheckResult } from "./types.ts";
import { declaredScopes, result } from "./types.ts";

export async function runFingerprintCheck(
  manifest: AgentManifest,
  sandbox: SandboxRunResult,
): Promise<TrustCheckResult> {
  const startedAt = new Date().toISOString();
  const declared = new Set(declaredScopes(manifest));
  const undeclared = sandbox.touched_scopes
    .filter((scope) => !declared.has(scope))
    .sort();
  return result({
    id: "fingerprint",
    label: "Behavioral fingerprint",
    outcome: undeclared.length > 0 ? "fail" : "pass",
    reason_codes: undeclared.length > 0 ? ["undeclared_scope_touched"] : [],
    startedAt,
    details: {
      declared_scopes: [...declared].sort(),
      touched_scopes: [...new Set(sandbox.touched_scopes)].sort(),
      undeclared_scopes: undeclared,
    },
  });
}
