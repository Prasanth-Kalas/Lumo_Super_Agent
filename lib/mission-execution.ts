import { getSupabase } from "./db.ts";
import {
  planToMissionRows,
  type MissionInsertRow,
  type MissionStepInsertRow,
} from "./mission-execution-core.ts";
import type { LumoMissionPlan } from "./lumo-mission.ts";

export interface MissionPersistResult {
  mission_id: string | null;
  step_count: number;
  persisted: boolean;
}

export interface MissionExecutionEventInput {
  mission_id: string;
  step_id?: string | null;
  event_type: string;
  payload?: Record<string, unknown>;
}

interface SupabaseLike {
  from(table: string): {
    insert(values: unknown): unknown;
  };
}

export async function persistMission(
  plan: LumoMissionPlan,
  user_id: string,
  session_id: string | null,
  options: { db?: SupabaseLike | null } = {},
): Promise<MissionPersistResult> {
  const rows = planToMissionRows(plan, user_id, session_id);
  if (rows.steps.length === 0) {
    return { mission_id: null, step_count: 0, persisted: false };
  }

  const db = options.db ?? getSupabase();
  if (!db) return { mission_id: null, step_count: 0, persisted: false };

  const missionInsert = await insertMission(db, rows.mission);
  if (missionInsert.error) {
    throw new Error(`mission_insert_failed:${missionInsert.error.message ?? "unknown"}`);
  }
  const mission_id = stringOrNull(missionInsert.data?.id);
  if (!mission_id) throw new Error("mission_insert_missing_id");

  const stepRows = rows.steps.map((step) => ({
    ...step,
    mission_id,
  }));
  const stepInsert = await insertRows(db, "mission_steps", stepRows);
  if (stepInsert.error) {
    throw new Error(`mission_steps_insert_failed:${stepInsert.error.message ?? "unknown"}`);
  }

  return {
    mission_id,
    step_count: rows.steps.length,
    persisted: true,
  };
}

export async function recordExecutionEvent(
  input: MissionExecutionEventInput,
  options: { db?: SupabaseLike | null } = {},
): Promise<void> {
  const db = options.db ?? getSupabase();
  if (!db) return;
  const { error } = await insertRows(db, "mission_execution_events", {
    mission_id: input.mission_id,
    step_id: input.step_id ?? null,
    event_type: input.event_type,
    payload: input.payload ?? {},
  });
  if (error) {
    throw new Error(`mission_event_insert_failed:${error.message ?? "unknown"}`);
  }
}

async function insertMission(
  db: SupabaseLike,
  mission: MissionInsertRow,
): Promise<{ data: { id?: unknown } | null; error: { message?: string } | null }> {
  const inserted = db.from("missions").insert(mission);
  const selectable = inserted as {
    select?: (columns: string) => {
      single?: () => Promise<{
        data: { id?: unknown } | null;
        error: { message?: string } | null;
      }>;
    };
  };
  const selected = selectable.select?.("id");
  const result = selected?.single?.();
  if (!result) return { data: null, error: { message: "missing_select_single" } };
  return await result;
}

async function insertRows(
  db: SupabaseLike,
  table: string,
  rows: (MissionStepInsertRow & { mission_id: string })[] | Record<string, unknown>,
): Promise<{ error: { message?: string } | null }> {
  const inserted = db.from(table).insert(rows) as
    | Promise<{ error: { message?: string } | null }>
    | { error?: { message?: string } | null };
  return await Promise.resolve(inserted).then((result) => ({
    error: result.error ?? null,
  }));
}

function stringOrNull(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input : null;
}
