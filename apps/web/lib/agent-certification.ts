import {
  HealthReportSchema,
  SDK_VERSION,
  openApiToClaudeTools,
  parseManifest,
  type AgentManifest,
  type BridgeResult,
  type OpenApiDocument,
} from "@lumo/agent-sdk";

export type CertificationSeverity = "blocker" | "high" | "medium" | "low" | "info";
export type CertificationStatus = "passed" | "needs_review" | "failed";

export interface CertificationFinding {
  severity: CertificationSeverity;
  code: string;
  message: string;
  evidence?: string;
}

export interface AgentCertificationReport {
  checked_at: string;
  status: CertificationStatus;
  manifest_url: string;
  agent_id: string | null;
  display_name: string | null;
  manifest_origin: string | null;
  endpoints: {
    manifest_url: string;
    openapi_url: string | null;
    health_url: string | null;
  };
  tools: Array<{
    name: string;
    cost_tier: string;
    requires_confirmation: string | false;
    pii_required: string[];
  }>;
  permissions: {
    connect_model: string | null;
    pii_scope: string[];
    required_scopes: string[];
  };
  summary: {
    blocker: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  findings: CertificationFinding[];
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_JSON_BYTES = 2_000_000;
const INJECTION_PATTERNS = [
  /\bignore (all )?(previous|prior|system|developer) instructions\b/i,
  /\bsystem prompt\b/i,
  /\bdeveloper message\b/i,
  /\bjailbreak\b/i,
  /\bprompt injection\b/i,
  /\breveal (secrets|tokens|keys|credentials)\b/i,
  /\bexfiltrate\b/i,
];

export async function certifyAgentManifestUrl(
  manifestUrl: string,
): Promise<{
  report: AgentCertificationReport;
  manifest: AgentManifest | null;
  openapi: OpenApiDocument | null;
  bridge: BridgeResult | null;
}> {
  const findings: CertificationFinding[] = [];
  const checked_at = new Date().toISOString();
  const manifest_origin = safeOrigin(manifestUrl);
  let manifest: AgentManifest | null = null;
  let openapi: OpenApiDocument | null = null;
  let bridge: BridgeResult | null = null;
  let openapi_url: string | null = null;
  let health_url: string | null = null;

  if (!isAllowedManifestUrl(manifestUrl)) {
    findings.push({
      severity: "blocker",
      code: "manifest_url_scheme",
      message: "Manifest URL must be HTTPS, except localhost during local development.",
      evidence: manifestUrl,
    });
    return {
      report: buildReport({
        checked_at,
        manifest_url: manifestUrl,
        manifest_origin,
        manifest,
        bridge,
        openapi_url,
        health_url,
        findings,
      }),
      manifest,
      openapi,
      bridge,
    };
  }

  try {
    const raw = await fetchJson(manifestUrl);
    manifest = parseManifest(raw);
    openapi_url = resolvePossiblyRelativeUrl(manifest.openapi_url, manifestUrl);
    health_url = resolvePossiblyRelativeUrl(manifest.health_url, manifestUrl);
  } catch (err) {
    findings.push({
      severity: "blocker",
      code: "manifest_invalid",
      message: "Manifest could not be fetched or parsed by the current SDK.",
      evidence: err instanceof Error ? err.message : String(err),
    });
    return {
      report: buildReport({
        checked_at,
        manifest_url: manifestUrl,
        manifest_origin,
        manifest,
        bridge,
        openapi_url,
        health_url,
        findings,
      }),
      manifest,
      openapi,
      bridge,
    };
  }

  addManifestChecks(manifestUrl, manifest, findings);

  try {
    openapi = (await fetchJson(openapi_url!)) as OpenApiDocument;
  } catch (err) {
    findings.push({
      severity: "blocker",
      code: "openapi_unreachable",
      message: "openapi_url could not be fetched as JSON.",
      evidence: err instanceof Error ? err.message : String(err),
    });
  }

  if (openapi) {
    try {
      bridge = openApiToClaudeTools(manifest.agent_id, openapi);
      addBridgeChecks(manifest, bridge, openapi, findings);
    } catch (err) {
      findings.push({
        severity: "blocker",
        code: "openapi_contract_invalid",
        message: "OpenAPI failed Lumo tool conversion or cancellation validation.",
        evidence: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    const rawHealth = await fetchJson(health_url!);
    const health = HealthReportSchema.parse(rawHealth);
    if (health.agent_id !== manifest.agent_id) {
      findings.push({
        severity: "high",
        code: "health_agent_mismatch",
        message: "Health endpoint agent_id does not match manifest agent_id.",
        evidence: `${health.agent_id} != ${manifest.agent_id}`,
      });
    }
    if (health.status !== "ok") {
      findings.push({
        severity: "medium",
        code: "health_not_ok",
        message: "Health endpoint is reachable but not reporting ok.",
        evidence: health.status,
      });
    }
  } catch (err) {
    findings.push({
      severity: "blocker",
      code: "health_invalid",
      message: "health_url could not be fetched or parsed.",
      evidence: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    report: buildReport({
      checked_at,
      manifest_url: manifestUrl,
      manifest_origin,
      manifest,
      bridge,
      openapi_url,
      health_url,
      findings,
    }),
    manifest,
    openapi,
    bridge,
  };
}

function addManifestChecks(
  manifestUrl: string,
  manifest: AgentManifest,
  findings: CertificationFinding[],
): void {
  const manifestOrigin = safeOrigin(manifestUrl);
  const endpointUrls: Array<[string, string]> = [
    ["openapi_url", manifest.openapi_url],
    ["health_url", manifest.health_url],
  ];
  if (manifest.connect.model === "oauth2") {
    endpointUrls.push(["authorize_url", manifest.connect.authorize_url]);
    endpointUrls.push(["token_url", manifest.connect.token_url]);
    if (manifest.connect.revocation_url) {
      endpointUrls.push(["revocation_url", manifest.connect.revocation_url]);
    } else {
      findings.push({
        severity: "medium",
        code: "oauth_revocation_missing",
        message: "OAuth agents should expose revocation_url so disconnect invalidates upstream tokens.",
      });
    }
  }

  for (const [name, url] of endpointUrls) {
    const origin = safeOrigin(url);
    if (manifestOrigin && origin && origin !== manifestOrigin) {
      findings.push({
        severity: "high",
        code: "cross_origin_endpoint",
        message: `${name} points at a different origin than the manifest.`,
        evidence: `${name}=${url}`,
      });
    }
  }

  const sdkMajor = SDK_VERSION.split(".")[0];
  const agentSdkMajor = manifest.capabilities.sdk_version.split(".")[0];
  if (sdkMajor !== agentSdkMajor) {
    findings.push({
      severity: "high",
      code: "sdk_major_mismatch",
      message: "Agent SDK major version does not match the Super Agent SDK major.",
      evidence: `${manifest.capabilities.sdk_version} vs ${SDK_VERSION}`,
    });
  }

  if (manifest.requires_payment && manifest.connect.model === "none") {
    findings.push({
      severity: "blocker",
      code: "payment_without_connection",
      message: "Payment-capable agents must require a user connection.",
    });
  }

  if (!manifest.listing?.privacy_policy_url) {
    findings.push({
      severity: "medium",
      code: "privacy_policy_missing",
      message: "Marketplace listing should include privacy_policy_url before public launch.",
    });
  }
  if (!manifest.listing?.terms_url) {
    findings.push({
      severity: "medium",
      code: "terms_missing",
      message: "Marketplace listing should include terms_url before public launch.",
    });
  }
}

function addBridgeChecks(
  manifest: AgentManifest,
  bridge: BridgeResult,
  openapi: OpenApiDocument,
  findings: CertificationFinding[],
): void {
  if (bridge.tools.length === 0) {
    findings.push({
      severity: "blocker",
      code: "no_tools",
      message: "OpenAPI exposes no x-lumo-tool operations.",
    });
  }

  const manifestPii = new Set<string>(manifest.pii_scope);
  for (const [toolName, routing] of Object.entries(bridge.routing)) {
    if (routing.cost_tier === "money" && manifest.connect.model === "none") {
      findings.push({
        severity: "blocker",
        code: "money_tool_without_connection",
        message: "Money tools cannot run on anonymous/public agents.",
        evidence: toolName,
      });
    }
    if (routing.cost_tier === "money" && routing.requires_confirmation === false) {
      findings.push({
        severity: "blocker",
        code: "money_tool_without_confirmation",
        message: "Money tools must require a structured confirmation summary.",
        evidence: toolName,
      });
    }
    for (const pii of routing.pii_required) {
      if (!manifestPii.has(pii)) {
        findings.push({
          severity: "high",
          code: "pii_not_declared",
          message: "Tool requires PII not declared in manifest.pii_scope.",
          evidence: `${toolName}: ${pii}`,
        });
      }
    }
  }

  for (const op of toolOperations(openapi)) {
    const text = `${op.operationId}\n${op.summary ?? ""}\n${op.description ?? ""}`;
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({
          severity: "high",
          code: "tool_prompt_injection_risk",
          message: "Tool metadata contains instruction-like or secret-seeking language.",
          evidence: op.operationId,
        });
        break;
      }
    }
    if ((op.description ?? "").length > 1600) {
      findings.push({
        severity: "low",
        code: "tool_description_long",
        message: "Tool description is unusually long and may bloat model context.",
        evidence: op.operationId,
      });
    }
  }
}

function buildReport(args: {
  checked_at: string;
  manifest_url: string;
  manifest_origin: string | null;
  manifest: AgentManifest | null;
  bridge: BridgeResult | null;
  openapi_url: string | null;
  health_url: string | null;
  findings: CertificationFinding[];
}): AgentCertificationReport {
  const summary = {
    blocker: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of args.findings) summary[f.severity]++;
  const status: CertificationStatus =
    summary.blocker > 0 || summary.high > 0
      ? "failed"
      : summary.medium > 0
        ? "needs_review"
        : "passed";

  const connect = args.manifest?.connect;
  return {
    checked_at: args.checked_at,
    status,
    manifest_url: args.manifest_url,
    agent_id: args.manifest?.agent_id ?? null,
    display_name: args.manifest?.display_name ?? null,
    manifest_origin: args.manifest_origin,
    endpoints: {
      manifest_url: args.manifest_url,
      openapi_url: args.openapi_url,
      health_url: args.health_url,
    },
    tools: args.bridge
      ? Object.entries(args.bridge.routing).map(([name, r]) => ({
          name,
          cost_tier: r.cost_tier,
          requires_confirmation: r.requires_confirmation,
          pii_required: r.pii_required,
        }))
      : [],
    permissions: {
      connect_model: connect?.model ?? null,
      pii_scope: args.manifest?.pii_scope ?? [],
      required_scopes:
        connect?.model === "oauth2"
          ? connect.scopes.filter((s) => s.required).map((s) => s.name)
          : [],
    },
    summary,
    findings: args.findings,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Lumo-Super-Agent-Certifier/1.0",
      },
    });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_JSON_BYTES) {
      throw new Error(`${url} response is too large (${len} bytes).`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function resolvePossiblyRelativeUrl(url: string, base: string): string {
  return url.startsWith("http") ? url : new URL(url, base).toString();
}

function isAllowedManifestUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    if (u.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

function safeOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function toolOperations(doc: OpenApiDocument): Array<{
  operationId: string;
  summary?: string;
  description?: string;
}> {
  const out: Array<{ operationId: string; summary?: string; description?: string }> = [];
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item ?? {})) {
      if (op && typeof op === "object" && op["x-lumo-tool"] === true) {
        out.push(op);
      }
    }
  }
  return out;
}
