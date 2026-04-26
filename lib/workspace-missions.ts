/**
 * DB glue for the user-facing /api/workspace/missions endpoint
 * (Sprint 3 / K11).
 *
 * Pulls a user's recent missions and their steps from Supabase, hands
 * the raw rows to the pure shaper in `workspace-missions-core.ts`, and
 * returns the card-ready array. Resilient to Supabase being absent
 * (returns `[]` so dev / CI / demo sandboxes don't crash) — same
 * pattern as `lib/admin-stats.ts`.
 *
 * Auth lives in the route handler; this module trusts the user_id its
 * caller hands it.
 */

import { getSupabase } from "./db.ts";
import {
  rowsToMissionCardData,
  trimRecentMissions,
  type MissionCardData,
  type RawMissionRow,
  type RawMissionStepRow,
} from "./workspace-missions-core.ts";

export type { MissionCardData } from "./workspace-missions-core.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

/**
 * Fetch the most-recently-touched missions for `user_id`, with their
 * step rows attached. The endpoint clamps `limit` to [1, 50]; we
 * clamp again here so direct callers (server components, future cron
 * jobs) can't accidentally pull a 10k-row scan.
 */
export async function fetchUserMissions(
  user_id: string,
  opts?: { limit?: number },
): Promise<MissionCardData[]> {
  if (!user_id || typeof user_id !== "string") return [];

  const requested = opts?.limit;
  const limit =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(requested)))
      : DEFAULT_LIMIT;

  const sb = getSupabase();
  if (!sb) return [];

  // 1) Recent missions for this user. The composite index
  // `missions_by_user_state_updated (user_id, state, updated_at desc)`
  // covers (user_id, updated_at desc) when state isn't filtered, so this
  // stays cheap even with a large mission table.
  const { data: missionRows, error: missionErr } = await sb
    .from("missions")
    .select("id, user_id, state, intent_text, created_at, updated_at")
    .eq("user_id", user_id)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (missionErr) {
    console.warn(
      "[workspace-missions] missions read failed:",
      missionErr.message,
    );
    return [];
  }

  const missions = (missionRows ?? []) as RawMissionRow[];
  // Defensive: re-trim in case the query somehow returned more than
  // `limit` rows (mock backends, future schema changes).
  const trimmed = trimRecentMissions(missions, limit);
  if (trimmed.length === 0) return [];

  const ids = trimmed
    .map((m) => (typeof m?.id === "string" ? m.id : null))
    .filter((id): id is string => !!id);

  // 2) All steps for the returned missions in one round trip.
  let steps: RawMissionStepRow[] = [];
  if (ids.length > 0) {
    const { data: stepRows, error: stepErr } = await sb
      .from("mission_steps")
      .select(
        "id, mission_id, step_order, agent_id, tool_name, status, reversibility, confirmation_card_id, started_at, finished_at, error_text",
      )
      .in("mission_id", ids);

    if (stepErr) {
      console.warn(
        "[workspace-missions] mission_steps read failed:",
        stepErr.message,
      );
    } else {
      steps = (stepRows ?? []) as RawMissionStepRow[];
    }
  }

  return rowsToMissionCardData(trimmed, steps);
}
