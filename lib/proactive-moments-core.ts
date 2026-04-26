import type {
  ProactiveMoment,
  ProactiveMomentType,
  ProactiveMomentUrgency,
} from "./proactive-moment-card-helpers.js";

export type ProactiveMomentAction = "acted_on" | "dismissed";

export interface ProactiveMomentsEnvelope {
  generated_at: string;
  moments: ProactiveMoment[];
}

const MOMENT_TYPES = new Set<ProactiveMomentType>([
  "anomaly_alert",
  "forecast_warning",
  "pattern_observation",
  "time_to_act",
  "opportunity",
]);

const URGENCIES = new Set<ProactiveMomentUrgency>(["low", "medium", "high"]);

export function normalizeProactiveMomentRows(rows: unknown): ProactiveMoment[] {
  if (!Array.isArray(rows)) return [];
  const out: ProactiveMoment[] = [];
  for (const raw of rows.slice(0, 25)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const id = stringValue(row.id);
    const moment_type = normalizeMomentType(row.moment_type);
    const title = stringValue(row.title);
    const body = stringValue(row.body);
    const urgency = normalizeUrgency(row.urgency);
    const valid_from = isoValue(row.valid_from);
    const created_at = isoValue(row.created_at);
    if (!id || !moment_type || !title || !body || !urgency || !valid_from || !created_at) {
      continue;
    }
    out.push({
      id,
      moment_type,
      title,
      body,
      evidence: recordValue(row.evidence),
      urgency,
      valid_from,
      valid_until: isoValue(row.valid_until),
      created_at,
    });
  }
  return out.sort(compareMoments);
}

export function normalizeMomentActionBody(body: unknown): ProactiveMomentAction | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).status ?? (body as Record<string, unknown>).action;
  if (raw === "acted_on" || raw === "dismissed") return raw;
  if (raw === "act") return "acted_on";
  if (raw === "dismiss") return "dismissed";
  return null;
}

function compareMoments(a: ProactiveMoment, b: ProactiveMoment): number {
  const urgencyDelta = urgencyRank(b.urgency) - urgencyRank(a.urgency);
  if (urgencyDelta !== 0) return urgencyDelta;
  return Date.parse(b.valid_from) - Date.parse(a.valid_from);
}

function urgencyRank(urgency: ProactiveMomentUrgency): number {
  if (urgency === "high") return 3;
  if (urgency === "medium") return 2;
  return 1;
}

function normalizeMomentType(value: unknown): ProactiveMomentType | null {
  return typeof value === "string" && MOMENT_TYPES.has(value as ProactiveMomentType)
    ? (value as ProactiveMomentType)
    : null;
}

function normalizeUrgency(value: unknown): ProactiveMomentUrgency | null {
  return typeof value === "string" && URGENCIES.has(value as ProactiveMomentUrgency)
    ? (value as ProactiveMomentUrgency)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isoValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
