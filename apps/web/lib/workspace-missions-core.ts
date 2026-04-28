/**
 * Pure helpers for the user-facing /api/workspace/missions endpoint
 * (Sprint 3 / K11).
 *
 * This is the user-side equivalent of `lib/admin-stats.ts`'s
 * `fetchRecentMissions` row-grouping logic — extracted into a pure
 * module so the shaping is testable from a `.test.mjs` without DB,
 * env, or fetch.
 *
 * The output shape mirrors what the K10 `MissionCard` component
 * consumes: a `MissionCardData` per mission with its `MissionCardStep`s
 * sorted by `step_order ASC`. Wiring the card into `/workspace` is a
 * separate post-D5 commit, so this module is intentionally minimal and
 * self-contained.
 */
import type {
  MissionCardData,
  MissionCardStep,
} from "./mission-card-helpers.ts";

export type {
  MissionCardData,
  MissionCardStep,
} from "./mission-card-helpers.ts";

// ──────────────────────────────────────────────────────────────────────────
// Raw row shapes — what Supabase hands back. Kept narrow on purpose so
// tests can construct fixtures with literal objects.
// ──────────────────────────────────────────────────────────────────────────

export interface RawMissionRow {
  id: string;
  user_id: string;
  state: string;
  intent_text: string;
  created_at: string;
  updated_at: string;
}

export interface RawMissionStepRow {
  id: string;
  mission_id: string;
  step_order: number;
  agent_id: string;
  tool_name: string;
  status: string;
  reversibility: string;
  confirmation_card_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_text: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Defensive coercion — Supabase JSON arrives as `unknown` until the
// caller asserts a shape. We accept partial / wrong-typed rows and drop
// the bad ones quietly rather than throwing — a single corrupt row
// shouldn't blank the whole workspace card list.
// ──────────────────────────────────────────────────────────────────────────

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceMissionRow(row: unknown): RawMissionRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = asString(r.id);
  const user_id = asString(r.user_id);
  const state = asString(r.state);
  const intent_text = asString(r.intent_text);
  const created_at = asString(r.created_at);
  const updated_at = asString(r.updated_at);
  if (!id || !user_id || !state || !created_at || !updated_at) return null;
  return {
    id,
    user_id,
    state,
    intent_text: intent_text ?? "",
    created_at,
    updated_at,
  };
}

function coerceStepRow(row: unknown): RawMissionStepRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = asString(r.id);
  const mission_id = asString(r.mission_id);
  const step_order = asInt(r.step_order);
  const agent_id = asString(r.agent_id);
  const tool_name = asString(r.tool_name);
  const status = asString(r.status);
  const reversibility = asString(r.reversibility);
  if (
    !id ||
    !mission_id ||
    step_order === null ||
    !agent_id ||
    !tool_name ||
    !status ||
    !reversibility
  ) {
    return null;
  }
  return {
    id,
    mission_id,
    step_order,
    agent_id,
    tool_name,
    status,
    reversibility,
    confirmation_card_id: asNullableString(r.confirmation_card_id),
    started_at: asNullableString(r.started_at),
    finished_at: asNullableString(r.finished_at),
    error_text: asNullableString(r.error_text),
  };
}

function stepToCardStep(s: RawMissionStepRow): MissionCardStep {
  return {
    id: s.id,
    step_order: s.step_order,
    agent_id: s.agent_id,
    tool_name: s.tool_name,
    // The card consumes the canonical union types — we cast through
    // `unknown` because the DB hands back `string` (constraint-checked
    // server-side, so any value here is in-range; if a future migration
    // widens the set the card already falls back to "Unknown").
    status: s.status as MissionCardStep["status"],
    reversibility: s.reversibility as MissionCardStep["reversibility"],
    confirmation_card_id: s.confirmation_card_id,
    started_at: s.started_at,
    finished_at: s.finished_at,
    error_text: s.error_text,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Public — shape rows into MissionCardData[]
// ──────────────────────────────────────────────────────────────────────────

/**
 * Group `steps` by `mission_id`, sort each bucket by `step_order ASC`,
 * and return one `MissionCardData` per input mission in input order.
 *
 * - Steps whose `mission_id` doesn't match any mission are dropped.
 * - Missions with no steps render with `steps: []` (the card handles).
 * - Malformed rows (missing `id`, non-numeric `step_order`, etc.) are
 *   dropped silently.
 */
export function rowsToMissionCardData(
  missions: RawMissionRow[] | null | undefined,
  steps: RawMissionStepRow[] | null | undefined,
): MissionCardData[] {
  const missionList = Array.isArray(missions) ? missions : [];
  if (missionList.length === 0) return [];

  const cleanMissions: RawMissionRow[] = [];
  const validIds = new Set<string>();
  for (const m of missionList) {
    const cm = coerceMissionRow(m);
    if (!cm) continue;
    cleanMissions.push(cm);
    validIds.add(cm.id);
  }
  if (cleanMissions.length === 0) return [];

  const stepList = Array.isArray(steps) ? steps : [];
  const stepsByMission = new Map<string, RawMissionStepRow[]>();
  for (const s of stepList) {
    const cs = coerceStepRow(s);
    if (!cs) continue;
    if (!validIds.has(cs.mission_id)) continue; // drop orphan steps
    let bucket = stepsByMission.get(cs.mission_id);
    if (!bucket) {
      bucket = [];
      stepsByMission.set(cs.mission_id, bucket);
    }
    bucket.push(cs);
  }

  const out: MissionCardData[] = [];
  for (const m of cleanMissions) {
    const bucket = stepsByMission.get(m.id) ?? [];
    bucket.sort((a, b) => a.step_order - b.step_order);
    out.push({
      id: m.id,
      state: m.state as MissionCardData["state"],
      intent_text: m.intent_text,
      created_at: m.created_at,
      updated_at: m.updated_at,
      steps: bucket.map(stepToCardStep),
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Defensive sort/slice — used when the DB query didn't already
// `order by updated_at desc limit N`. Kept pure so callers can wire
// it up regardless of how the rows were obtained.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sort `missions` by `updated_at DESC` and slice to `limit`. Limit is
 * clamped to [1, input.length] — values <=0 yield an empty array, NaN
 * is treated as "no limit" (returns the full sorted list).
 */
export function trimRecentMissions(
  missions: RawMissionRow[] | null | undefined,
  limit: number,
): RawMissionRow[] {
  const list = Array.isArray(missions) ? [...missions] : [];
  if (list.length === 0) return [];
  list.sort((a, b) => {
    const ta = Date.parse(a?.updated_at ?? "") || 0;
    const tb = Date.parse(b?.updated_at ?? "") || 0;
    return tb - ta;
  });
  if (typeof limit !== "number" || !Number.isFinite(limit)) return list;
  if (limit <= 0) return [];
  if (limit >= list.length) return list;
  return list.slice(0, limit);
}
