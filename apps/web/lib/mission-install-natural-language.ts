import { getSupabase } from "./db.js";
import { recordExecutionEvent } from "./mission-execution.ts";
import {
  commitMissionInstallApproval,
  MissionInstallApprovalError,
} from "./mission-install-approval.js";
import {
  detectPendingInstallDecision,
  installStateChangeFrame,
  selectSinglePendingInstallProposal,
  type PendingInstallDecision,
  type PendingInstallPlanLike,
} from "./mission-install-natural-language-core.ts";

export interface NaturalLanguageInstallCommitResult {
  decision: PendingInstallDecision;
  mission_id: string;
  agent_id: string;
  display_name: string;
  state_frame: ReturnType<typeof installStateChangeFrame>;
  assistant_text: string;
}

interface MissionRow {
  id?: unknown;
  plan?: unknown;
}

export async function commitPendingInstallDecisionFromText(args: {
  user_id: string;
  session_id: string;
  text: string;
}): Promise<NaturalLanguageInstallCommitResult | null> {
  const decision = detectPendingInstallDecision(args.text);
  if (!decision || !args.user_id || args.user_id === "anon") return null;
  const session_id = args.session_id.trim();
  if (!session_id) return null;

  const latest = await readLatestPendingPermissionMission(args.user_id, session_id);
  if (!latest) return null;

  const plan = toPlan(latest.plan);
  const proposal = selectSinglePendingInstallProposal(plan);
  if (!proposal) return null;

  const agent_id = String(proposal.agent_id).trim();
  const display_name =
    typeof proposal.display_name === "string" && proposal.display_name.trim()
      ? proposal.display_name.trim()
      : agent_id;
  const mission_id =
    typeof plan.mission_id === "string" && plan.mission_id.trim()
      ? plan.mission_id.trim()
      : String(latest.id ?? "");
  if (!agent_id || !mission_id) return null;

  if (decision === "cancel") {
    await recordExecutionEvent({
      mission_id: String(latest.id ?? mission_id),
      event_type: "permission_declined",
      payload: {
        agent_id,
        source: "natural_language_install_commit",
      },
    }).catch((err) => {
      console.warn("[mission-install-natural-language] decline event failed", {
        mission_id,
        agent_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return {
      decision,
      mission_id,
      agent_id,
      display_name,
      state_frame: installStateChangeFrame({
        mission_id,
        agent_id,
        display_name,
        state: "cancelled",
      }),
      assistant_text: `Cancelled ${display_name}. I won't use it for this mission.`,
    };
  }

  try {
    await commitMissionInstallApproval({
      user_id: args.user_id,
      session_id,
      agent_id,
      approval_idempotency_key:
        typeof proposal.approval_idempotency_key === "string"
          ? proposal.approval_idempotency_key
          : null,
      mission_id,
      original_request:
        typeof plan.original_request === "string" ? plan.original_request : null,
      profile_fields_approved: proposal.profile_fields_requested,
    });
  } catch (err) {
    if (err instanceof MissionInstallApprovalError && err.code === "oauth_required") {
      return null;
    }
    throw err;
  }

  return {
    decision,
    mission_id,
    agent_id,
    display_name,
    state_frame: installStateChangeFrame({
      mission_id,
      agent_id,
      display_name,
      state: "approved",
    }),
    assistant_text: `Approved ${display_name} — let's go.`,
  };
}

async function readLatestPendingPermissionMission(
  user_id: string,
  session_id: string,
): Promise<MissionRow | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("missions")
    .select("id, plan")
    .eq("user_id", user_id)
    .eq("session_id", session_id)
    .eq("state", "awaiting_permissions")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) {
    console.warn("[mission-install-natural-language] pending mission read failed", {
      session_id,
      error: error.message,
    });
    return null;
  }
  return Array.isArray(data) ? (data[0] as MissionRow | undefined) ?? null : null;
}

function toPlan(input: unknown): PendingInstallPlanLike {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as PendingInstallPlanLike)
    : {};
}
