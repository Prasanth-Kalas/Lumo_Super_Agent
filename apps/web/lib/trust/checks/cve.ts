import type { AgentManifest } from "@lumo/agent-sdk";
import type { TrustCheckResult } from "./types.js";
import { manifestDependencies, result } from "./types.js";

const KNOWN_HIGH_RISK_PACKAGES = new Set(["event-stream", "flatmap-stream"]);

export async function runCveCheck(manifest: AgentManifest): Promise<TrustCheckResult> {
  const startedAt = new Date().toISOString();
  const dependencies = manifestDependencies(manifest);
  const findings: Array<{ name: string; version: string; severity: "high" | "medium"; source: string }> = [];
  for (const dep of dependencies) {
    if (KNOWN_HIGH_RISK_PACKAGES.has(dep.name.toLowerCase()) || /vulnerable|malware/i.test(dep.version)) {
      findings.push({ name: dep.name, version: dep.version, severity: "high", source: "local-denylist" });
    }
  }

  if (process.env.LUMO_TRUST_OSV_ENABLED === "true" && dependencies.length > 0) {
    findings.push(...await queryOsvBestEffort(dependencies));
  }

  const high = findings.filter((f) => f.severity === "high");
  const medium = findings.filter((f) => f.severity === "medium");
  return result({
    id: "cve",
    label: "Dependency CVE scan",
    outcome: high.length > 0 ? "fail" : medium.length > 0 ? "warn" : "pass",
    reason_codes: high.length > 0 ? ["critical_or_high_cve"] : [],
    startedAt,
    details: { dependency_count: dependencies.length, findings },
  });
}

async function queryOsvBestEffort(
  dependencies: Array<{ name: string; version: string; ecosystem: "npm" }>,
): Promise<Array<{ name: string; version: string; severity: "high" | "medium"; source: string }>> {
  const findings: Array<{ name: string; version: string; severity: "high" | "medium"; source: string }> = [];
  for (const dep of dependencies.slice(0, 50)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch("https://api.osv.dev/v1/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          package: { ecosystem: "npm", name: dep.name },
          version: dep.version.replace(/^[^\d]*/, ""),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const body = await res.json() as { vulns?: Array<{ severity?: Array<{ score?: string; type?: string }> }> };
      for (const vuln of body.vulns ?? []) {
        const scores = vuln.severity ?? [];
        const high = scores.some((s) => /9\.|10\./.test(String(s.score ?? "")));
        findings.push({
          name: dep.name,
          version: dep.version,
          severity: high ? "high" : "medium",
          source: "osv.dev",
        });
      }
    } catch {
      findings.push({ name: dep.name, version: dep.version, severity: "medium", source: "osv_timeout" });
    }
  }
  return findings;
}
