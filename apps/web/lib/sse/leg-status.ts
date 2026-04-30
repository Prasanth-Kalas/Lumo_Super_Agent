export const LEG_STATUS_V2_STATUSES = [
  "pending",
  "in_flight",
  "committed",
  "failed",
  "rollback_pending",
  "rolled_back",
  "rollback_failed",
  "manual_review",
] as const;

export type LegStatusV2Status = typeof LEG_STATUS_V2_STATUSES[number];

export interface LegStatusFrameV2 {
  leg_id: string;
  transaction_id: string;
  agent_id: string;
  capability_id: string;
  status: LegStatusV2Status;
  provider_reference?: string;
  evidence?: Record<string, unknown>;
  timestamp: string;
}

export interface LegStatusEventRow {
  leg_id: string;
  transaction_id: string;
  agent_id: string;
  capability_id: string;
  status: string;
  provider_reference?: string | null;
  evidence?: unknown;
  occurred_at?: string | null;
  created_at?: string | null;
}

const LEG_STATUS_SET = new Set<string>(LEG_STATUS_V2_STATUSES);

export function isLegStatusV2Status(value: unknown): value is LegStatusV2Status {
  return typeof value === "string" && LEG_STATUS_SET.has(value);
}

export function legStatusFrameFromRow(row: LegStatusEventRow): LegStatusFrameV2 {
  if (!isLegStatusV2Status(row.status)) {
    throw new Error(`invalid_leg_status:${row.status}`);
  }

  return buildLegStatusFrame({
    leg_id: row.leg_id,
    transaction_id: row.transaction_id,
    agent_id: row.agent_id,
    capability_id: row.capability_id,
    status: row.status,
    provider_reference: row.provider_reference ?? undefined,
    evidence: normalizeEvidence(row.evidence),
    timestamp: row.occurred_at ?? row.created_at ?? new Date(0).toISOString(),
  });
}

export function buildLegStatusFrame(input: LegStatusFrameV2): LegStatusFrameV2 {
  return {
    leg_id: input.leg_id,
    transaction_id: input.transaction_id,
    agent_id: input.agent_id,
    capability_id: input.capability_id,
    status: input.status,
    ...(input.provider_reference ? { provider_reference: input.provider_reference } : {}),
    ...(input.evidence && Object.keys(input.evidence).length > 0
      ? { evidence: input.evidence }
      : {}),
    timestamp: normalizeTimestamp(input.timestamp),
  };
}

export function serializeLegStatusSse(frame: LegStatusFrameV2): string {
  return `event: leg_status\ndata: ${JSON.stringify(buildLegStatusFrame(frame))}\n\n`;
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date(0).toISOString();
  return date.toISOString();
}

function normalizeEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
