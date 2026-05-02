import type {
  LumoMissionPlan,
  MissionAgentCandidate,
  MissionInstallProposal,
} from "./lumo-mission.js";

export type MissionState =
  | "draft"
  | "awaiting_permissions"
  | "awaiting_user_input"
  | "ready"
  | "executing"
  | "awaiting_confirmation"
  | "rolling_back"
  | "completed"
  | "failed"
  | "rolled_back";

export type Reversibility = "reversible" | "compensating" | "irreversible";

export type MissionStepStatus =
  | "pending"
  | "awaiting_confirmation"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "rollback_failed"
  | "rolled_back"
  | "skipped";

export interface MissionInsertRow {
  user_id: string;
  session_id: string | null;
  intent_text: string;
  state: MissionState;
  plan: LumoMissionPlan;
}

export interface MissionStepInsertRow {
  step_order: number;
  agent_id: string;
  tool_name: string;
  reversibility: Reversibility;
  status: MissionStepStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  confirmation_card_id: string | null;
  client_step_id?: string | null;
  dependency_mode?: "step_order" | "explicit";
  depends_on_step_orders?: number[];
  dispatch_tool_name?: string | null;
  output_summary?: string | null;
}

export interface MissionRows {
  mission: MissionInsertRow;
  steps: MissionStepInsertRow[];
}

export interface MissionStepForConfirmation {
  id?: string;
  mission_id?: string;
  status: MissionStepStatus;
  confirmation_card_id?: string | null;
  error_text?: string | null;
}

export type ConfirmationCardOutcome = "approved" | "dismissed" | "expired";

export interface ConfirmationStepUpdate {
  confirmation_card_id?: string;
  status?: MissionStepStatus;
  error_text?: string | null;
}

const STATE_TRANSITIONS: Record<MissionState, MissionState[]> = {
  draft: ["awaiting_permissions", "awaiting_user_input", "ready", "failed", "rolled_back"],
  awaiting_permissions: ["awaiting_user_input", "ready", "failed", "rolling_back", "rolled_back"],
  awaiting_user_input: ["awaiting_permissions", "ready", "failed", "rolling_back"],
  ready: ["executing", "awaiting_confirmation", "failed", "rolling_back"],
  executing: ["awaiting_confirmation", "completed", "failed", "rolling_back"],
  awaiting_confirmation: ["executing", "completed", "failed", "rolling_back"],
  rolling_back: ["rolled_back", "failed"],
  completed: ["rolling_back"],
  failed: ["rolling_back", "rolled_back"],
  rolled_back: [],
};

const BOOKING_OR_PAYMENT_PATTERN =
  /\b(book|booking|reserve|reservation|order|purchase|payment|pay|checkout|fare|ticket|account creation|create account)\b/;
const SEND_OR_PUBLISH_PATTERN =
  /\b(send|message|email|reply|dm|sms|publish|post|comment)\b/;

export function validNextStates(current: MissionState): MissionState[] {
  return [...STATE_TRANSITIONS[current]];
}

export function transition(
  current: MissionState,
  target: MissionState,
): { ok: boolean; reason?: string } {
  if (current === target) {
    return { ok: false, reason: "target_state_matches_current_state" };
  }
  if (STATE_TRANSITIONS[current].includes(target)) return { ok: true };
  return {
    ok: false,
    reason: `invalid_transition:${current}->${target}`,
  };
}

export function planToMissionRows(
  plan: LumoMissionPlan,
  user_id: string,
  session_id: string | null,
): MissionRows {
  const installProposalsByAgent = new Map(
    plan.install_proposals.map((proposal) => [proposal.agent_id, proposal]),
  );
  const steps = plan.required_agents.map((agent, index) =>
    agentToStepRow(agent, installProposalsByAgent.get(agent.agent_id), index),
  );
  return {
    mission: {
      user_id,
      session_id,
      intent_text: plan.original_request,
      state: inferInitialMissionState(plan, steps.length),
      plan,
    },
    steps,
  };
}

export function linkConfirmationCardToStep(
  missionStep: MissionStepForConfirmation,
  confirmationCardId: string,
): { ok: boolean; update?: ConfirmationStepUpdate; reason?: string } {
  const cardId = confirmationCardId.trim();
  if (!cardId) return { ok: false, reason: "missing_confirmation_card_id" };
  if (
    missionStep.status !== "pending" &&
    missionStep.status !== "awaiting_confirmation"
  ) {
    return {
      ok: false,
      reason: `step_not_linkable:${missionStep.status}`,
    };
  }
  return {
    ok: true,
    update: {
      confirmation_card_id: cardId,
      status: "awaiting_confirmation",
      error_text: null,
    },
  };
}

export function applyCardOutcome(
  missionStep: MissionStepForConfirmation,
  outcome: ConfirmationCardOutcome,
): { ok: boolean; update?: ConfirmationStepUpdate; reason?: string } {
  if (missionStep.status !== "awaiting_confirmation") {
    return {
      ok: false,
      reason: `step_not_awaiting_confirmation:${missionStep.status}`,
    };
  }

  if (outcome === "approved") {
    return { ok: true, update: { status: "ready", error_text: null } };
  }
  if (outcome === "dismissed") {
    return {
      ok: true,
      update: { status: "skipped", error_text: "confirmation dismissed" },
    };
  }
  return {
    ok: true,
    update: { status: "failed", error_text: "confirmation expired" },
  };
}

function agentToStepRow(
  agent: MissionAgentCandidate,
  installProposal: MissionInstallProposal | undefined,
  index: number,
): MissionStepInsertRow {
  const reversibility = inferReversibility(agent, installProposal);
  return {
    step_order: index,
    agent_id: agent.agent_id,
    tool_name: missionToolName(agent),
    reversibility,
    status: agent.state === "ready" ? "ready" : "pending",
    inputs: {
      capability: agent.capability,
      capability_label: agent.capability_label,
      agent_state: agent.state,
      state_reason: agent.state_reason,
      required_scopes: agent.required_scopes,
      pii_scope: agent.pii_scope,
      requires_payment: agent.requires_payment,
      install_action: installProposal?.action ?? null,
      risk_badge: agent.risk_badge,
      rank_score: agent.rank_score,
      rollback: agent.rollback ?? null,
    },
    outputs: {},
    confirmation_card_id: null,
  };
}

function inferInitialMissionState(
  plan: LumoMissionPlan,
  stepCount: number,
): MissionState {
  if (stepCount === 0) return "draft";
  const hasPendingSteps = plan.required_agents.some((agent) => agent.state !== "ready");
  if (plan.install_proposals.length > 0 && hasPendingSteps) {
    return "awaiting_permissions";
  }
  if (plan.should_pause_for_permission && !plan.can_continue_now) {
    return "awaiting_permissions";
  }
  if (plan.user_questions.length > 0) return "awaiting_user_input";
  if (plan.can_continue_now || plan.ready_agents.length > 0) return "ready";
  if (hasPendingSteps) return "awaiting_permissions";
  return "draft";
}

function inferReversibility(
  agent: MissionAgentCandidate,
  installProposal: MissionInstallProposal | undefined,
): Reversibility {
  if (installProposal?.action === "grant_lumo_id") return "irreversible";
  if (agent.requires_payment) return "irreversible";

  const semantics = [
    agent.capability,
    agent.capability_label,
    agent.domain,
    agent.display_name,
    agent.reason,
    agent.one_liner,
  ]
    .join(" ")
    .toLowerCase();

  if (BOOKING_OR_PAYMENT_PATTERN.test(semantics)) return "irreversible";
  if (SEND_OR_PUBLISH_PATTERN.test(semantics)) return "compensating";
  return "reversible";
}

function missionToolName(agent: MissionAgentCandidate): string {
  return `mission.${agent.capability.replace(/[^a-z0-9_]+/gi, "_").toLowerCase()}`;
}
