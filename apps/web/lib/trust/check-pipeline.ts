import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentManifest } from "@lumo/agent-sdk";
import { runCveCheck } from "./checks/cve.ts";
import { runFingerprintCheck } from "./checks/fingerprint.ts";
import { runManifestCheck } from "./checks/manifest.ts";
import { runSandboxCheck } from "./checks/sandbox.ts";
import { runStaticAnalysisCheck } from "./checks/static.ts";
import type { TrustCheckContext, TrustCheckResult } from "./checks/types.ts";

export interface CheckReport {
  passed: boolean;
  agent_id: string;
  agent_version: string;
  checks: TrustCheckResult[];
  failed_check: string | null;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  completed_at: string;
}

export async function runChecks(input: {
  agentId: string;
  agentVersion: string;
  manifest: unknown;
  bundleBytes?: Uint8Array | null;
  db?: SupabaseClient | null;
  queueId?: string | null;
}): Promise<CheckReport> {
  const checks: TrustCheckResult[] = [];
  const ctx: TrustCheckContext = {
    agentId: input.agentId,
    version: input.agentVersion,
    manifestRaw: input.manifest,
    bundleBytes: input.bundleBytes ?? null,
  };

  const manifestCheck = await runManifestCheck(ctx);
  checks.push(manifestCheck.check);
  if (manifestCheck.check.outcome === "fail" || !manifestCheck.manifest) {
    return finalize(input, checks);
  }

  const manifest = manifestCheck.manifest as AgentManifest;
  ctx.manifest = manifest;

  const cve = await runCveCheck(manifest, input.manifest as Record<string, unknown>);
  checks.push(cve);
  if (cve.outcome === "fail") return finalize(input, checks);

  const staticResult = await runStaticAnalysisCheck(ctx);
  checks.push(staticResult);
  if (staticResult.outcome === "fail") return finalize(input, checks);

  const sandbox = await runSandboxCheck(manifest, input.manifest);
  checks.push(sandbox.check);
  if (sandbox.check.outcome === "fail") return finalize(input, checks);

  checks.push(await runFingerprintCheck(manifest, sandbox.sandbox));
  return finalize(input, checks);
}

async function finalize(
  input: {
    agentId: string;
    agentVersion: string;
    db?: SupabaseClient | null;
    queueId?: string | null;
  },
  checks: TrustCheckResult[],
): Promise<CheckReport> {
  const failed = checks.find((check) => check.outcome === "fail") ?? null;
  const report: CheckReport = {
    passed: failed === null,
    agent_id: input.agentId,
    agent_version: input.agentVersion,
    checks,
    failed_check: failed?.id ?? null,
    summary: {
      pass: checks.filter((check) => check.outcome === "pass").length,
      warn: checks.filter((check) => check.outcome === "warn").length,
      fail: checks.filter((check) => check.outcome === "fail").length,
    },
    completed_at: new Date().toISOString(),
  };

  if (input.db && input.queueId) {
    await input.db
      .from("agent_review_queue")
      .update({ automated_checks: report })
      .eq("id", input.queueId);
  }
  return report;
}
