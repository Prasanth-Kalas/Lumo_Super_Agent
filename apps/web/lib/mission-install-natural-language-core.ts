export type PendingInstallDecision = "approve" | "cancel";

export interface PendingInstallProposalLike {
  agent_id?: unknown;
  display_name?: unknown;
  can_auto_install?: unknown;
  approval_idempotency_key?: unknown;
  profile_fields_requested?: unknown;
}

export interface PendingInstallPlanLike {
  mission_id?: unknown;
  original_request?: unknown;
  install_proposals?: unknown;
}

const APPROVE_PENDING_INSTALL_RE =
  /\b(approve|approved|install|yes|yeah|yep|sure|go ahead|let'?s do it|do it|sounds good|okay|ok)\b/i;
const CANCEL_PENDING_INSTALL_RE =
  /\b(no thanks|no thank you|cancel|skip|stop|not now|nope|don'?t|do not|never mind|nevermind)\b/i;

export function detectPendingInstallDecision(
  text: string,
): PendingInstallDecision | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (CANCEL_PENDING_INSTALL_RE.test(trimmed)) return "cancel";
  if (APPROVE_PENDING_INSTALL_RE.test(trimmed)) return "approve";
  return null;
}

export function selectSinglePendingInstallProposal(
  plan: PendingInstallPlanLike | null | undefined,
): PendingInstallProposalLike | null {
  const proposals = Array.isArray(plan?.install_proposals)
    ? plan.install_proposals.filter(isProposal)
    : [];
  const autoInstallable = proposals.filter(
    (proposal) => proposal.can_auto_install === true,
  );
  if (autoInstallable.length !== 1) return null;
  return autoInstallable[0] ?? null;
}

export function installStateChangeFrame(input: {
  mission_id: string;
  agent_id: string;
  display_name: string;
  state: "approved" | "cancelled";
}): {
  kind: "mission_install_state_change";
  detail: {
    mission_id: string;
    agent_id: string;
    display_name: string;
    state: "approved" | "cancelled";
  };
} {
  return {
    kind: "mission_install_state_change",
    detail: {
      mission_id: input.mission_id,
      agent_id: input.agent_id,
      display_name: input.display_name,
      state: input.state,
    },
  };
}

function isProposal(input: unknown): input is PendingInstallProposalLike {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const proposal = input as PendingInstallProposalLike;
  return typeof proposal.agent_id === "string" && proposal.agent_id.trim().length > 0;
}
