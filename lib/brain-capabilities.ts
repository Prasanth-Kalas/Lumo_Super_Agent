import type { EndpointSummary } from "./admin/intelligence-api";

export type BrainCapabilityId =
  | "knowledge_graph"
  | "bandit"
  | "voice"
  | "wake_word"
  | "multimodal"
  | "runtime";

export type BrainCapabilityStatus = "ready" | "watch" | "pending";

export interface BrainCapability {
  id: BrainCapabilityId;
  title: string;
  description: string;
  status: BrainCapabilityStatus;
  statusLabel: string;
  matchedEndpoints: string[];
  nextStep: string;
}

export interface BrainCapabilityCounts {
  ready: number;
  watch: number;
  pending: number;
  total: number;
}

interface CapabilityDefinition {
  id: BrainCapabilityId;
  title: string;
  description: string;
  matchers: string[];
  pendingStep: string;
}

const DEFINITIONS: CapabilityDefinition[] = [
  {
    id: "knowledge_graph",
    title: "Knowledge Graph",
    description: "Multi-hop memory recall with graph citations.",
    matchers: ["kg", "graph"],
    pendingStep: "Run the synthetic Sam graph smoke and verify cited recall.",
  },
  {
    id: "bandit",
    title: "Personalization",
    description: "Bandit ranking for proactive moments and suggestions.",
    matchers: ["bandit", "personalize", "preference"],
    pendingStep: "Ship BANDIT-1 and start reward traffic.",
  },
  {
    id: "voice",
    title: "Voice",
    description: "Speech, emotion-aware playback, and owner voice work.",
    matchers: ["voice", "tts", "transcribe", "whisper"],
    pendingStep: "Finish the consent-gated self-hosted voice path.",
  },
  {
    id: "wake_word",
    title: "Wake Word",
    description: "Hands-free Hey Lumo listener with local privacy guardrails.",
    matchers: ["wake"],
    pendingStep: "Complete the browser wake-word engine and privacy smoke.",
  },
  {
    id: "multimodal",
    title: "Multimodal Recall",
    description: "Unified text, image, document, and audio retrieval.",
    matchers: ["multimodal", "recall_unified", "clip", "image", "pdf"],
    pendingStep: "Wire MMRAG-1 against the unified embedding index.",
  },
  {
    id: "runtime",
    title: "Runtime Intelligence",
    description: "Cost, drift, latency, routing, and breaker telemetry.",
    matchers: ["runtime", "classify", "forecast", "anomaly", "embed", "recall"],
    pendingStep: "Keep SDK telemetry flowing through brain_call_log.",
  },
];

export function buildBrainCapabilityChecklist(
  endpoints: EndpointSummary[] | null | undefined,
): BrainCapability[] {
  const rows = Array.isArray(endpoints) ? endpoints : [];
  return DEFINITIONS.map((definition) => {
    const matches = matchingEndpoints(definition, rows);
    const status = capabilityStatus(matches, rows, definition.id);
    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      status,
      statusLabel: statusLabel(status),
      matchedEndpoints: matches.map((m) => m.endpoint),
      nextStep: nextStep(definition, status, matches),
    };
  });
}

export function brainCapabilityCounts(
  capabilities: BrainCapability[] | null | undefined,
): BrainCapabilityCounts {
  const rows = Array.isArray(capabilities) ? capabilities : [];
  const counts: BrainCapabilityCounts = {
    ready: 0,
    watch: 0,
    pending: 0,
    total: rows.length,
  };
  for (const row of rows) {
    counts[row.status] += 1;
  }
  return counts;
}

export function brainCapabilitySummary(
  capabilities: BrainCapability[] | null | undefined,
): string {
  const counts = brainCapabilityCounts(capabilities);
  if (counts.total === 0) return "No Phase 3 capabilities configured yet.";
  if (counts.ready === counts.total) {
    return "All Phase 3 brain capabilities are showing live signals.";
  }
  const parts = [
    `${counts.ready} ready`,
    `${counts.watch} watch`,
    `${counts.pending} pending`,
  ];
  return parts.join(" · ");
}

function matchingEndpoints(
  definition: CapabilityDefinition,
  endpoints: EndpointSummary[],
): EndpointSummary[] {
  return endpoints.filter((endpoint) => {
    const name = endpoint.endpoint.toLowerCase();
    return definition.matchers.some((matcher) => name.includes(matcher));
  });
}

function capabilityStatus(
  matches: EndpointSummary[],
  allEndpoints: EndpointSummary[],
  id: BrainCapabilityId,
): BrainCapabilityStatus {
  if (id === "runtime" && allEndpoints.length > 0) {
    return hasUnhealthyEndpoint(allEndpoints) ? "watch" : "ready";
  }
  if (matches.length === 0) return "pending";
  return hasUnhealthyEndpoint(matches) ? "watch" : "ready";
}

function hasUnhealthyEndpoint(endpoints: EndpointSummary[]): boolean {
  return endpoints.some((endpoint) => {
    return (
      endpoint.error_rate_24h >= 0.03 ||
      endpoint.circuit_breaker.state === "open" ||
      endpoint.circuit_breaker.state === "half_open"
    );
  });
}

function statusLabel(status: BrainCapabilityStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "watch":
      return "Watch";
    case "pending":
      return "Pending";
  }
}

function nextStep(
  definition: CapabilityDefinition,
  status: BrainCapabilityStatus,
  matches: EndpointSummary[],
): string {
  if (status === "pending") return definition.pendingStep;
  if (status === "watch") {
    const open = matches.find((m) => m.circuit_breaker.state !== "closed");
    if (open) return `Check ${open.endpoint}; breaker is ${open.circuit_breaker.state.replace("_", "-")}.`;
    const noisy = matches.find((m) => m.error_rate_24h >= 0.03);
    if (noisy) return `Check ${noisy.endpoint}; error rate is elevated.`;
    return "Review elevated error or latency telemetry.";
  }
  if (matches.length === 0) return "Live telemetry is present.";
  return `${matches.length} signal${matches.length === 1 ? "" : "s"} active.`;
}
