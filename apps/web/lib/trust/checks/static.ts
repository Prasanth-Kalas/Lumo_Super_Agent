import type { TrustCheckContext, TrustCheckResult } from "./types.ts";
import { result } from "./types.ts";

const BLOCKED_PATTERNS: Array<{ code: string; re: RegExp; description: string }> = [
  { code: "eval_usage", re: /\beval\s*\(/, description: "Dynamic eval is forbidden in marketplace bundles." },
  { code: "function_constructor", re: /\bnew\s+Function\s*\(|\bFunction\s*\(/, description: "Function constructor is forbidden." },
  { code: "child_process", re: /child_process|spawn\s*\(|execFile\s*\(|exec\s*\(/, description: "Subprocess spawn is outside the agent sandbox contract." },
  { code: "raw_fs_write", re: /fs\.(writeFile|appendFile|createWriteStream|rm|unlink|rename)/, description: "Filesystem writes must go through ctx.state." },
  { code: "secret_env_access", re: /process\.env\.[A-Z0-9_]*(SECRET|TOKEN|KEY)/, description: "Raw secret env access is not permitted from community bundles." },
];

export async function runStaticAnalysisCheck(ctx: TrustCheckContext): Promise<TrustCheckResult> {
  const startedAt = new Date().toISOString();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(ctx.bundleBytes ?? new Uint8Array());
  const findings = BLOCKED_PATTERNS
    .filter((pattern) => pattern.re.test(text))
    .map((pattern) => ({
      code: pattern.code,
      description: pattern.description,
    }));
  return result({
    id: "static",
    label: "Static analysis",
    outcome: findings.length > 0 ? "fail" : "pass",
    reason_codes: findings.map((f) => f.code),
    startedAt,
    details: {
      scanned_bytes: ctx.bundleBytes?.byteLength ?? 0,
      findings,
    },
  });
}
