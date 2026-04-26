import { getSupabase } from "./db.ts";
import {
  inputAdvancement,
  pendingStepIds,
  stepsToAdvanceOnPermissionGrant,
  type GateMission,
  type GateMissionStep,
} from "./mission-gate-resolution-core.ts";
import { recordExecutionEvent } from "./mission-execution.ts";

interface SupabaseLike {
  from(table: string): any;
}

export interface PermissionGateResult {
  missions_checked: number;
  missions_advanced: number;
  steps_advanced: number;
}

export interface InputGateResult {
  mission_id: string;
  complete: boolean;
  state: string | null;
  steps_advanced: number;
  reason?: string;
}

export async function resolvePermissionGate(
  user_id: string,
  agent_id: string,
  options: { db?: SupabaseLike | null } = {},
): Promise<PermissionGateResult> {
  const db = options.db ?? getSupabase();
  const result: PermissionGateResult = {
    missions_checked: 0,
    missions_advanced: 0,
    steps_advanced: 0,
  };
  if (!db || !user_id || !agent_id) return result;

  const missions = await readMissions(db, user_id, ["awaiting_permissions"]);
  result.missions_checked = missions.length;

  for (const mission of missions) {
    const steps = await readMissionSteps(db, mission.id);
    const resolution = stepsToAdvanceOnPermissionGrant(mission, steps, agent_id);
    if (resolution.step_ids.length === 0) continue;

    await updateMissionSteps(db, resolution.step_ids, {
      status: "ready",
      error_text: null,
    });
    result.steps_advanced += resolution.step_ids.length;
    result.missions_advanced += 1;

    await recordExecutionEvent(
      {
        mission_id: mission.id,
        event_type: "permission_resolved",
        payload: {
          agent_id,
          steps_advanced: resolution.step_ids.length,
          next_state: resolution.next_state,
        },
      },
      { db },
    );

    if (resolution.complete) {
      await updateMission(db, mission.id, { state: "ready" });
    }
  }

  return result;
}

export async function resolveInputGate(
  mission_id: string,
  inputs: Record<string, unknown>,
  user_id: string,
  options: { db?: SupabaseLike | null } = {},
): Promise<InputGateResult> {
  const db = options.db ?? getSupabase();
  if (!db) {
    return {
      mission_id,
      complete: false,
      state: null,
      steps_advanced: 0,
      reason: "persistence_disabled",
    };
  }

  const mission = await readMission(db, mission_id, user_id);
  if (!mission) {
    return {
      mission_id,
      complete: false,
      state: null,
      steps_advanced: 0,
      reason: "mission_not_found",
    };
  }

  const resolution = inputAdvancement(mission, inputs);
  const update: Record<string, unknown> = { plan: resolution.merged_plan };
  let advancedStepIds: string[] = [];

  if (resolution.complete) {
    const steps = await readMissionSteps(db, mission.id);
    advancedStepIds = pendingStepIds(steps);
    if (advancedStepIds.length > 0) {
      await updateMissionSteps(db, advancedStepIds, {
        status: "ready",
        error_text: null,
      });
    }
    update.state = "ready";
  }

  await updateMission(db, mission.id, update);
  await recordExecutionEvent(
    {
      mission_id: mission.id,
      event_type: "input_resolved",
      payload: {
        input_keys: Object.keys(resolution.merged_inputs).sort(),
        complete: resolution.complete,
        steps_advanced: advancedStepIds.length,
        reason: resolution.reason ?? null,
      },
    },
    { db },
  );

  return {
    mission_id: mission.id,
    complete: resolution.complete,
    state: resolution.next_state,
    steps_advanced: advancedStepIds.length,
    reason: resolution.reason,
  };
}

export async function resolveLatestInputGateForSession(
  user_id: string,
  session_id: string,
  inputs: Record<string, unknown>,
  options: { db?: SupabaseLike | null } = {},
): Promise<InputGateResult | null> {
  const db = options.db ?? getSupabase();
  if (!db || !user_id || !session_id) return null;
  const mission = await readLatestMissionForSession(db, user_id, session_id);
  if (!mission) return null;
  return resolveInputGate(mission.id, inputs, user_id, { db });
}

async function readMissions(
  db: SupabaseLike,
  user_id: string,
  states: string[],
): Promise<GateMission[]> {
  const { data, error } = await db
    .from("missions")
    .select("id, user_id, session_id, state, plan")
    .eq("user_id", user_id)
    .in("state", states)
    .order("updated_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(`missions_gate_read_failed:${error.message ?? "unknown"}`);
  return Array.isArray(data) ? data.map(normalizeMission).filter(isMission) : [];
}

async function readMission(
  db: SupabaseLike,
  mission_id: string,
  user_id: string,
): Promise<GateMission | null> {
  const { data, error } = await db
    .from("missions")
    .select("id, user_id, session_id, state, plan")
    .eq("id", mission_id)
    .eq("user_id", user_id)
    .limit(1);
  if (error) throw new Error(`mission_gate_read_failed:${error.message ?? "unknown"}`);
  return normalizeMission(Array.isArray(data) ? data[0] : null);
}

async function readLatestMissionForSession(
  db: SupabaseLike,
  user_id: string,
  session_id: string,
): Promise<GateMission | null> {
  const { data, error } = await db
    .from("missions")
    .select("id, user_id, session_id, state, plan")
    .eq("user_id", user_id)
    .eq("session_id", session_id)
    .eq("state", "awaiting_user_input")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`mission_input_gate_read_failed:${error.message ?? "unknown"}`);
  return normalizeMission(Array.isArray(data) ? data[0] : null);
}

async function readMissionSteps(
  db: SupabaseLike,
  mission_id: string,
): Promise<GateMissionStep[]> {
  const { data, error } = await db
    .from("mission_steps")
    .select("id, mission_id, agent_id, status, inputs")
    .eq("mission_id", mission_id)
    .order("step_order", { ascending: true });
  if (error) throw new Error(`mission_gate_steps_read_failed:${error.message ?? "unknown"}`);
  return Array.isArray(data) ? data.map(normalizeStep).filter(isStep) : [];
}

async function updateMissionSteps(
  db: SupabaseLike,
  stepIds: string[],
  update: Record<string, unknown>,
): Promise<void> {
  if (stepIds.length === 0) return;
  const { error } = await db.from("mission_steps").update(update).in("id", stepIds);
  if (error) throw new Error(`mission_gate_steps_update_failed:${error.message ?? "unknown"}`);
}

async function updateMission(
  db: SupabaseLike,
  mission_id: string,
  update: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("missions").update(update).eq("id", mission_id);
  if (error) throw new Error(`mission_gate_update_failed:${error.message ?? "unknown"}`);
}

function normalizeMission(row: unknown): GateMission | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = stringOrNull(r.id);
  const state = stringOrNull(r.state);
  if (!id || !state) return null;
  return {
    id,
    user_id: stringOrNull(r.user_id),
    session_id: stringOrNull(r.session_id),
    state,
    plan: isRecord(r.plan) ? r.plan : {},
  };
}

function normalizeStep(row: unknown): GateMissionStep | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = stringOrNull(r.id);
  const mission_id = stringOrNull(r.mission_id);
  const agent_id = stringOrNull(r.agent_id);
  const status = stringOrNull(r.status);
  if (!id || !mission_id || !agent_id || !status) return null;
  return {
    id,
    mission_id,
    agent_id,
    status,
    inputs: isRecord(r.inputs) ? r.inputs : {},
  };
}

function isMission(row: GateMission | null): row is GateMission {
  return row !== null;
}

function isStep(row: GateMissionStep | null): row is GateMissionStep {
  return row !== null;
}

function stringOrNull(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
