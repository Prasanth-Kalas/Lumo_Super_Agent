export type CompoundLegDetailStatus =
  | "pending"
  | "in_flight"
  | "committed"
  | "failed"
  | "rollback_pending"
  | "rolled_back"
  | "rollback_failed"
  | "manual_review";

export interface CompoundLegDetailLeg {
  leg_id: string;
  agent_id: string;
  agent_display_name: string;
  description: string;
  status: CompoundLegDetailStatus;
  depends_on?: string[];
}

export interface CompoundLegMetadata {
  timestamp?: string | null;
  provider_reference?: string | null;
  evidence?: Record<string, string> | null;
}

export interface CompoundLegDetailLine {
  label: string;
  text: string;
  tone: "primary" | "secondary" | "success" | "warning" | "error";
  mono?: boolean;
}

export interface CompoundLegDetailModel {
  lines: CompoundLegDetailLine[];
  elapsed_started_at: string | null;
}

const FAILURE_REASON_COPY: Record<string, string> = {
  rate_unavailable: "Rate unavailable — provider re-quoted between price-lock and book.",
  card_declined: "Card declined.",
  provider_timeout: "Provider timed out before confirming.",
  inventory_changed: "Inventory changed mid-flight.",
  policy_blocked: "Blocked by booking policy.",
  duplicate_idempotency: "Duplicate idempotency key — booking may already exist.",
};

export function compoundLegDetailModel(input: {
  leg: CompoundLegDetailLeg;
  status: CompoundLegDetailStatus;
  metadata: CompoundLegMetadata;
  settled: boolean;
  allLegs: CompoundLegDetailLeg[];
}): CompoundLegDetailModel {
  const { leg, status, metadata, settled, allLegs } = input;
  if (status === "pending") {
    const depName = previousLegDescription(leg.leg_id, allLegs);
    return {
      lines: [
        {
          label: "QUEUED",
          text: depName
            ? `Waiting for ${depName}`
            : "Waiting for an earlier leg to commit",
          tone: "secondary",
        },
      ],
      elapsed_started_at: null,
    };
  }

  if (status === "in_flight" || status === "rollback_pending") {
    return {
      lines: [
        {
          label: status === "rollback_pending" ? "ROLLING BACK" : "SEARCHING",
          text: `${providerLabel(leg)} — ${activityForAgent(leg.agent_id)}`,
          tone: "primary",
        },
      ],
      elapsed_started_at: !settled && metadata.timestamp ? metadata.timestamp : null,
    };
  }

  if (status === "committed") {
    const lines: CompoundLegDetailLine[] = [
      { label: "CONFIRMED", text: "Booking complete.", tone: "success" },
    ];
    if (metadata.provider_reference) {
      lines.push({
        label: "REFERENCE",
        text: metadata.provider_reference,
        tone: "secondary",
        mono: true,
      });
    }
    for (const [key, value] of sortedEvidenceEntries(metadata.evidence)) {
      lines.push({
        label: evidenceLabel(key),
        text: value,
        tone: "secondary",
      });
    }
    return { lines, elapsed_started_at: null };
  }

  if (status === "manual_review") {
    const lines: CompoundLegDetailLine[] = [
      {
        label: "MANUAL REVIEW",
        text: "Awaiting manual review — the Lumo team will follow up shortly.",
        tone: "warning",
      },
    ];
    const reason = metadata.evidence?.reason;
    if (reason) lines.push({ label: "REASON", text: reason, tone: "secondary" });
    return { lines, elapsed_started_at: null };
  }

  const title =
    status === "failed"
      ? "FAILED"
      : status === "rolled_back"
        ? "ROLLED BACK"
        : "ROLLBACK FAILED";
  return {
    lines: [
      {
        label: title,
        text: failureReason(metadata),
        tone: "error",
      },
      {
        label: "SAGA",
        text: sagaActionDescription(status),
        tone: "secondary",
      },
    ],
    elapsed_started_at: null,
  };
}

export function hasCompoundLegMetadata(metadata: CompoundLegMetadata | null | undefined): boolean {
  if (!metadata) return false;
  return Boolean(
    (metadata.timestamp && metadata.timestamp.trim()) ||
      (metadata.provider_reference && metadata.provider_reference.trim()) ||
      (metadata.evidence && Object.keys(metadata.evidence).length > 0),
  );
}

export function mergeCompoundLegMetadata(
  current: CompoundLegMetadata | null | undefined,
  incoming: CompoundLegMetadata | null | undefined,
): CompoundLegMetadata {
  const merged: CompoundLegMetadata = { ...(current ?? {}) };
  if (!incoming) return merged;
  if (incoming.timestamp) merged.timestamp = incoming.timestamp;
  if (incoming.provider_reference) {
    merged.provider_reference = incoming.provider_reference;
  }
  if (incoming.evidence && Object.keys(incoming.evidence).length > 0) {
    merged.evidence = {
      ...(merged.evidence ?? {}),
      ...incoming.evidence,
    };
  }
  return merged;
}

export function coerceCompoundEvidence(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key.trim() || value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function normalizeCompoundTimestamp(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function elapsedLabel(from: string, now: Date): string {
  const started = new Date(from);
  const secs = Number.isNaN(started.getTime())
    ? 0
    : Math.max(0, Math.floor((now.getTime() - started.getTime()) / 1000));
  if (secs < 60) return `Elapsed: ${secs}s`;
  const minutes = Math.floor(secs / 60);
  const seconds = secs % 60;
  return `Elapsed: ${minutes}m ${seconds}s`;
}

export function isCompoundTerminalStatus(status: CompoundLegDetailStatus): boolean {
  return (
    status === "committed" ||
    status === "failed" ||
    status === "rolled_back" ||
    status === "rollback_failed" ||
    status === "manual_review"
  );
}

function previousLegDescription(
  legId: string,
  allLegs: CompoundLegDetailLeg[],
): string | null {
  const current = allLegs.find((leg) => leg.leg_id === legId);
  const firstDependency = current?.depends_on?.[0];
  if (firstDependency) {
    const dependency = allLegs.find((leg) => leg.leg_id === firstDependency);
    if (dependency?.description) return dependency.description;
  }
  const index = allLegs.findIndex((leg) => leg.leg_id === legId);
  if (index <= 0) return null;
  return allLegs[index - 1]?.description ?? null;
}

function providerLabel(leg: CompoundLegDetailLeg): string {
  const id = leg.agent_id;
  if (id.includes("flight")) return "Duffel";
  if (id.includes("hotel")) return "Booking.com";
  if (id.includes("restaurant") || id.includes("dining")) return "OpenTable";
  return leg.agent_display_name;
}

function activityForAgent(agentId: string): string {
  if (agentId.includes("flight")) return "available flights";
  if (agentId.includes("hotel")) return "available rooms";
  if (agentId.includes("restaurant")) return "open reservation slots";
  if (agentId.includes("food")) return "menu options";
  return "matching options";
}

function failureReason(metadata: CompoundLegMetadata): string {
  const reason = metadata.evidence?.reason;
  if (reason) return humanizeReason(reason);
  const providerStatus = metadata.evidence?.provider_status;
  if (providerStatus) return `Provider returned ${providerStatus}.`;
  return "The booking step couldn't complete.";
}

function humanizeReason(raw: string): string {
  return FAILURE_REASON_COPY[raw] ?? raw.replace(/_/g, " ");
}

function sagaActionDescription(status: CompoundLegDetailStatus): string {
  if (status === "failed") return "Saga halted; dependent legs will roll back.";
  if (status === "rolled_back") {
    return "This leg was rolled back as part of a saga compensation; the booking did not commit.";
  }
  if (status === "rollback_failed") {
    return "Compensating rollback could not complete — escalated to the Lumo team.";
  }
  return "";
}

function sortedEvidenceEntries(
  evidence: Record<string, string> | null | undefined,
): Array<[string, string]> {
  if (!evidence) return [];
  return Object.keys(evidence)
    .sort()
    .map((key) => [key, evidence[key] ?? ""]);
}

function evidenceLabel(key: string): string {
  return key.toUpperCase().replace(/_/g, " ");
}
