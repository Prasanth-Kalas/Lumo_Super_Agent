export type PreferenceSurface =
  | "chat_suggestion"
  | "marketplace_tile"
  | "mission_card"
  | "workspace_card";

export type PreferenceTargetType =
  | "suggestion"
  | "agent"
  | "mission_action"
  | "workspace_card"
  | "workspace_prompt";

export type PreferenceEventType = "impression" | "click" | "dismiss" | "dwell";

export type PreferenceJson =
  | null
  | boolean
  | number
  | string
  | PreferenceJson[]
  | { [key: string]: PreferenceJson };

export interface PreferenceEventInput {
  surface: PreferenceSurface;
  target_type: PreferenceTargetType;
  target_id: string;
  event_type: PreferenceEventType;
  dwell_ms?: number | null;
  session_id?: string | null;
  context?: unknown;
  metadata?: unknown;
}

export interface NormalizedPreferenceEvent {
  surface: PreferenceSurface;
  target_type: PreferenceTargetType;
  target_id: string;
  event_type: PreferenceEventType;
  dwell_ms: number | null;
  session_id: string | null;
  context: PreferenceJson;
  metadata: PreferenceJson;
}

export const PREFERENCE_SURFACES: readonly PreferenceSurface[] = [
  "chat_suggestion",
  "marketplace_tile",
  "mission_card",
  "workspace_card",
] as const;

export const PREFERENCE_TARGET_TYPES: readonly PreferenceTargetType[] = [
  "suggestion",
  "agent",
  "mission_action",
  "workspace_card",
  "workspace_prompt",
] as const;

export const PREFERENCE_EVENT_TYPES: readonly PreferenceEventType[] = [
  "impression",
  "click",
  "dismiss",
  "dwell",
] as const;

const MAX_TARGET_ID = 200;
const MAX_SESSION_ID = 120;
const MAX_JSON_DEPTH = 3;
const MAX_JSON_KEYS = 24;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 500;

const SURFACE_SET = new Set<string>(PREFERENCE_SURFACES);
const TARGET_TYPE_SET = new Set<string>(PREFERENCE_TARGET_TYPES);
const EVENT_TYPE_SET = new Set<string>(PREFERENCE_EVENT_TYPES);

export function normalizePreferenceEvent(
  input: unknown,
): NormalizedPreferenceEvent | null {
  if (!isRecord(input)) return null;

  const surface = input.surface;
  const target_type = input.target_type;
  const event_type = input.event_type;
  if (
    typeof surface !== "string" ||
    !SURFACE_SET.has(surface) ||
    typeof target_type !== "string" ||
    !TARGET_TYPE_SET.has(target_type) ||
    typeof event_type !== "string" ||
    !EVENT_TYPE_SET.has(event_type)
  ) {
    return null;
  }

  const rawTargetId = typeof input.target_id === "string" ? input.target_id.trim() : "";
  if (!rawTargetId) return null;

  const dwell_ms = normalizeDwellMs(input.dwell_ms);
  if (event_type === "dwell" && dwell_ms === null) return null;

  return {
    surface: surface as PreferenceSurface,
    target_type: target_type as PreferenceTargetType,
    target_id: rawTargetId.slice(0, MAX_TARGET_ID),
    event_type: event_type as PreferenceEventType,
    dwell_ms,
    session_id:
      typeof input.session_id === "string" && input.session_id.trim()
        ? input.session_id.trim().slice(0, MAX_SESSION_ID)
        : null,
    context: sanitizePreferenceJson(input.context),
    metadata: sanitizePreferenceJson(input.metadata),
  };
}

export function normalizePreferenceEvents(
  input: unknown,
  options: { maxEvents?: number } = {},
): NormalizedPreferenceEvent[] {
  const rawEvents = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.events)
      ? input.events
      : isRecord(input)
        ? [input]
        : [];
  const maxEvents = clampInteger(options.maxEvents ?? 50, 1, 100);
  const normalized: NormalizedPreferenceEvent[] = [];
  for (const raw of rawEvents.slice(0, maxEvents)) {
    const event = normalizePreferenceEvent(raw);
    if (event) normalized.push(event);
  }
  return normalized;
}

export function sanitizePreferenceJson(value: unknown): PreferenceJson {
  return sanitizeJsonValue(value, 0);
}

function sanitizeJsonValue(value: unknown, depth: number): PreferenceJson {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (depth >= MAX_JSON_DEPTH) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, PreferenceJson> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_JSON_KEYS)) {
      if (!key || key.length > 80) continue;
      out[key] = sanitizeJsonValue(child, depth + 1);
    }
    return out;
  }
  return null;
}

function normalizeDwellMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return clampInteger(Math.round(n), 0, 24 * 60 * 60 * 1000);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
