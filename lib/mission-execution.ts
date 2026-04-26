import { getSupabase } from "./db.ts";
import {
  applyCardOutcome,
  linkConfirmationCardToStep,
  planToMissionRows,
  type ConfirmationCardOutcome,
  type ConfirmationStepUpdate,
  type MissionInsertRow,
  type MissionStepForConfirmation,
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
  from(table: string): any;
}

export interface ConfirmationLinkResult {
  linked: boolean;
  mission_step_id: string | null;
  mission_id: string | null;
  reason?: string;
}

export interface ConfirmationResolveResult {
  resolved: number;
  outcome: ConfirmationCardOutcome;
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

export async function linkConfirmationCard(
  mission_step_id: string,
  confirmation_card_id: string,
  options: { db?: SupabaseLike | null } = {},
): Promise<ConfirmationLinkResult> {
  const db = options.db ?? getSupabase();
  if (!db) {
    return {
      linked: false,
      mission_step_id,
      mission_id: null,
      reason: "persistence_disabled",
    };
  }

  const step = await readMissionStepById(db, mission_step_id);
  if (!step) {
    return {
      linked: false,
      mission_step_id,
      mission_id: null,
      reason: "mission_step_not_found",
    };
  }
  const linked = linkConfirmationCardToStep(step, confirmation_card_id);
  if (!linked.ok || !linked.update) {
    return {
      linked: false,
      mission_step_id,
      mission_id: step.mission_id ?? null,
      reason: linked.reason,
    };
  }

  await updateMissionStep(db, mission_step_id, linked.update);
  if (step.mission_id) {
    await updateMissionState(db, step.mission_id, "awaiting_confirmation");
  }
  return {
    linked: true,
    mission_step_id,
    mission_id: step.mission_id ?? null,
  };
}

export async function linkConfirmationCardForLatestMissionStep(args: {
  user_id: string;
  session_id: string;
  agent_id: string;
  confirmation_card_id: string;
  db?: SupabaseLike | null;
}): Promise<ConfirmationLinkResult> {
  const db = args.db ?? getSupabase();
  if (!db) {
    return {
      linked: false,
      mission_step_id: null,
      mission_id: null,
      reason: "persistence_disabled",
    };
  }
  const mission = await readLatestMissionForSession(db, args.user_id, args.session_id);
  if (!mission) {
    return {
      linked: false,
      mission_step_id: null,
      mission_id: null,
      reason: "mission_not_found",
    };
  }
  const step = await readMissionStepForAgent(db, mission.id, args.agent_id);
  if (!step?.id) {
    return {
      linked: false,
      mission_step_id: null,
      mission_id: mission.id,
      reason: "mission_step_not_found",
    };
  }
  return linkConfirmationCard(step.id, args.confirmation_card_id, { db });
}

export async function linkConfirmationCardForLatestMissionSteps(args: {
  user_id: string;
  session_id: string;
  agent_ids: string[];
  confirmation_card_id: string;
  db?: SupabaseLike | null;
}): Promise<ConfirmationLinkResult[]> {
  const uniqueAgentIds = Array.from(new Set(args.agent_ids.filter(Boolean)));
  const results: ConfirmationLinkResult[] = [];
  for (const agent_id of uniqueAgentIds) {
    results.push(
      await linkConfirmationCardForLatestMissionStep({
        user_id: args.user_id,
        session_id: args.session_id,
        agent_id,
        confirmation_card_id: args.confirmation_card_id,
        db: args.db,
      }),
    );
  }
  return results;
}

export async function resolveCardOutcome(
  confirmation_card_id: string,
  outcome: ConfirmationCardOutcome,
  options: { db?: SupabaseLike | null } = {},
): Promise<ConfirmationResolveResult> {
  const db = options.db ?? getSupabase();
  if (!db) return { resolved: 0, outcome };

  const steps = await readMissionStepsByCardId(db, confirmation_card_id);
  let resolved = 0;
  const missionIds = new Set<string>();
  for (const step of steps) {
    if (!step.id) continue;
    const applied = applyCardOutcome(step, outcome);
    if (!applied.ok || !applied.update) continue;
    await updateMissionStep(db, step.id, applied.update);
    if (step.mission_id) {
      await recordExecutionEvent(
        {
          mission_id: step.mission_id,
          step_id: step.id,
          event_type: "card_resolved",
          payload: {
            confirmation_card_id,
            outcome,
            status: applied.update.status,
          },
        },
        { db },
      );
      missionIds.add(step.mission_id);
    }
    resolved += 1;
  }

  for (const mission_id of missionIds) {
    await transitionMissionReadyIfAllStepsResolved(db, mission_id);
  }
  return { resolved, outcome };
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

async function readMissionStepById(
  db: SupabaseLike,
  mission_step_id: string,
): Promise<MissionStepForConfirmation | null> {
  const { data, error } = await db
    .from("mission_steps")
    .select("id, mission_id, status, confirmation_card_id, error_text")
    .eq("id", mission_step_id)
    .limit(1);
  if (error) throw new Error(`mission_step_read_failed:${error.message ?? "unknown"}`);
  return normalizeStepRow(Array.isArray(data) ? data[0] : null);
}

async function readMissionStepsByCardId(
  db: SupabaseLike,
  confirmation_card_id: string,
): Promise<MissionStepForConfirmation[]> {
  const { data, error } = await db
    .from("mission_steps")
    .select("id, mission_id, status, confirmation_card_id, error_text")
    .eq("confirmation_card_id", confirmation_card_id);
  if (error) throw new Error(`mission_steps_card_read_failed:${error.message ?? "unknown"}`);
  return Array.isArray(data)
    ? data.map(normalizeStepRow).filter((row): row is MissionStepForConfirmation => row !== null)
    : [];
}

async function readLatestMissionForSession(
  db: SupabaseLike,
  user_id: string,
  session_id: string,
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("missions")
    .select("id")
    .eq("user_id", user_id)
    .eq("session_id", session_id)
    .in("state", [
      "draft",
      "awaiting_permissions",
      "awaiting_user_input",
      "ready",
      "executing",
      "awaiting_confirmation",
    ])
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`mission_read_failed:${error.message ?? "unknown"}`);
  const id = stringOrNull(Array.isArray(data) ? data[0]?.id : null);
  return id ? { id } : null;
}

async function readMissionStepForAgent(
  db: SupabaseLike,
  mission_id: string,
  agent_id: string,
): Promise<MissionStepForConfirmation | null> {
  const { data, error } = await db
    .from("mission_steps")
    .select("id, mission_id, status, confirmation_card_id, error_text")
    .eq("mission_id", mission_id)
    .eq("agent_id", agent_id)
    .in("status", ["pending", "awaiting_confirmation"])
    .order("step_order", { ascending: true })
    .limit(1);
  if (error) throw new Error(`mission_step_agent_read_failed:${error.message ?? "unknown"}`);
  return normalizeStepRow(Array.isArray(data) ? data[0] : null);
}

async function updateMissionStep(
  db: SupabaseLike,
  mission_step_id: string,
  update: ConfirmationStepUpdate,
): Promise<void> {
  const { error } = await db.from("mission_steps").update(update).eq("id", mission_step_id);
  if (error) throw new Error(`mission_step_update_failed:${error.message ?? "unknown"}`);
}

async function updateMissionState(
  db: SupabaseLike,
  mission_id: string,
  state: string,
): Promise<void> {
  const { error } = await db.from("missions").update({ state }).eq("id", mission_id);
  if (error) throw new Error(`mission_update_failed:${error.message ?? "unknown"}`);
}

async function transitionMissionReadyIfAllStepsResolved(
  db: SupabaseLike,
  mission_id: string,
): Promise<void> {
  const { data: missionData, error: missionError } = await db
    .from("missions")
    .select("id, state")
    .eq("id", mission_id)
    .limit(1);
  if (missionError) throw new Error(`mission_read_failed:${missionError.message ?? "unknown"}`);
  const missionState = Array.isArray(missionData) ? missionData[0]?.state : null;
  if (missionState !== "awaiting_confirmation") return;

  const { data: stepData, error: stepError } = await db
    .from("mission_steps")
    .select("status")
    .eq("mission_id", mission_id);
  if (stepError) throw new Error(`mission_steps_read_failed:${stepError.message ?? "unknown"}`);
  const statuses = Array.isArray(stepData)
    ? stepData.map((row) => String(row?.status ?? ""))
    : [];
  if (
    statuses.length > 0 &&
    statuses.every((status) => ["ready", "succeeded", "skipped"].includes(status))
  ) {
    await updateMissionState(db, mission_id, "ready");
  }
}

function normalizeStepRow(row: unknown): MissionStepForConfirmation | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status : null;
  if (
    !status ||
    ![
      "pending",
      "awaiting_confirmation",
      "ready",
      "running",
      "succeeded",
      "failed",
      "rollback_failed",
      "rolled_back",
      "skipped",
    ].includes(status)
  ) {
    return null;
  }
  return {
    id: stringOrNull(r.id) ?? undefined,
    mission_id: stringOrNull(r.mission_id) ?? undefined,
    status: status as MissionStepForConfirmation["status"],
    confirmation_card_id: stringOrNull(r.confirmation_card_id),
    error_text: stringOrNull(r.error_text),
  };
}
