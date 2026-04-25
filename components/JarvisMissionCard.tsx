"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export interface JarvisMissionScope {
  name: string;
  description: string;
  required: boolean;
}

export interface JarvisMissionProposal {
  agent_id: string;
  display_name: string;
  one_liner: string;
  capability_label: string;
  marketplace_url: string;
  action:
    | "install"
    | "install_with_profile_permission"
    | "connect_oauth"
    | "grant_lumo_id";
  can_auto_install: boolean;
  permission_title: string;
  permission_copy: string;
  profile_fields_requested: string[];
  required_scopes: JarvisMissionScope[];
  requires_payment: boolean;
}

export interface JarvisUnavailableCapability {
  capability: string;
  capability_label: string;
  reason: string;
  requested_phrase: string;
}

export interface JarvisMissionPlan {
  mission_id: string;
  original_request: string;
  mission_title: string;
  message: string;
  install_proposals: JarvisMissionProposal[];
  unavailable_capabilities: JarvisUnavailableCapability[];
}

interface JarvisMissionCardProps {
  plan: JarvisMissionPlan;
  disabled?: boolean;
  onContinue: (text: string) => void;
}

type InstallState = "idle" | "working" | "done" | "error";

export function JarvisMissionCard({
  plan,
  disabled = false,
  onContinue,
}: JarvisMissionCardProps) {
  const [stateByAgent, setStateByAgent] = useState<Record<string, InstallState>>({});
  const [error, setError] = useState<string | null>(null);

  const autoInstallable = useMemo(
    () => plan.install_proposals.filter((p) => p.can_auto_install),
    [plan.install_proposals],
  );
  const oauthProposals = useMemo(
    () => plan.install_proposals.filter((p) => p.action === "connect_oauth"),
    [plan.install_proposals],
  );
  const allAutoInstalled =
    autoInstallable.length > 0 &&
    autoInstallable.every((p) => stateByAgent[p.agent_id] === "done");
  const hasOAuth = oauthProposals.length > 0;

  async function installProposal(proposal: JarvisMissionProposal): Promise<boolean> {
    if (disabled || stateByAgent[proposal.agent_id] === "working") return false;
    setError(null);

    if (proposal.action === "connect_oauth") {
      await startOAuth(proposal);
      return false;
    }

    setStateByAgent((prev) => ({ ...prev, [proposal.agent_id]: "working" }));
    try {
      const res = await fetch("/api/jarvis/mission/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: proposal.agent_id,
          mission_id: plan.mission_id,
          original_request: plan.original_request,
          user_approved: true,
          profile_fields_approved: proposal.profile_fields_requested,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.detail ?? j?.error ?? `HTTP ${res.status}`);
      }
      setStateByAgent((prev) => ({ ...prev, [proposal.agent_id]: "done" }));
      return true;
    } catch (err) {
      setStateByAgent((prev) => ({ ...prev, [proposal.agent_id]: "error" }));
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function installAllAndContinue() {
    for (const proposal of autoInstallable) {
      if (stateByAgent[proposal.agent_id] === "done") continue;
      const ok = await installProposal(proposal);
      if (!ok) return;
    }
    if (!hasOAuth) continueMission();
  }

  async function startOAuth(proposal: JarvisMissionProposal) {
    setStateByAgent((prev) => ({ ...prev, [proposal.agent_id]: "working" }));
    try {
      const res = await fetch("/api/connections/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: proposal.agent_id,
          redirect_after: `/?mission=${encodeURIComponent(plan.mission_id)}`,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.detail ?? j?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { authorize_url: string };
      window.location.href = body.authorize_url;
    } catch (err) {
      setStateByAgent((prev) => ({ ...prev, [proposal.agent_id]: "error" }));
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function continueMission() {
    onContinue(
      `Yes, continue with available approved apps and skip unavailable marketplace capabilities for now: ${plan.original_request}`,
    );
  }

  return (
    <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
      <div className="flex flex-col gap-1">
        <div className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
          JARVIS app permission
        </div>
        <div className="text-[15px] font-semibold tracking-tight text-lumo-fg">
          {plan.install_proposals.length > 0
            ? `Approve apps for ${plan.mission_title}`
            : `Review ${plan.mission_title}`}
        </div>
        <p className="text-[12.5px] leading-relaxed text-lumo-fg-mid">
          {plan.install_proposals.length > 0
            ? "I will only install or connect these apps after your approval. Profile details stay limited to the fields each app declares."
            : "One requested capability is not available in the approved marketplace yet. You can continue with the parts JARVIS can safely handle."}
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {plan.install_proposals.map((proposal) => {
          const state = stateByAgent[proposal.agent_id] ?? "idle";
          return (
            <div
              key={`${proposal.agent_id}-${proposal.action}`}
              className="rounded-md border border-lumo-hair bg-lumo-elevated/55 p-3"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium text-lumo-fg">
                      {proposal.display_name}
                    </span>
                    <span className="rounded-full border border-lumo-hair px-2 py-0.5 text-[10.5px] text-lumo-fg-low">
                      {proposal.capability_label}
                    </span>
                    {proposal.requires_payment ? (
                      <span className="rounded-full border border-lumo-warn/30 bg-lumo-warn/10 px-2 py-0.5 text-[10.5px] text-lumo-warn">
                        confirmation required
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-lumo-fg-mid">
                    {proposal.one_liner}
                  </p>
                  <p className="mt-2 text-[11.5px] leading-relaxed text-lumo-fg-low">
                    {proposal.permission_copy}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {proposal.profile_fields_requested.length > 0 ? (
                      proposal.profile_fields_requested.map((field) => (
                        <span
                          key={field}
                          className="rounded-full bg-lumo-bg px-2 py-0.5 text-[10.5px] text-lumo-fg-low"
                        >
                          {field}
                        </span>
                      ))
                    ) : (
                      <span className="rounded-full bg-lumo-bg px-2 py-0.5 text-[10.5px] text-lumo-fg-low">
                        no profile fields
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href={proposal.marketplace_url}
                    className="h-8 rounded-md border border-lumo-hair px-3 text-[12px] leading-8 text-lumo-fg-mid hover:border-lumo-edge hover:text-lumo-fg transition-colors"
                  >
                    Details
                  </Link>
                  <button
                    type="button"
                    disabled={disabled || state === "working" || state === "done"}
                    onClick={() => void installProposal(proposal)}
                    className="h-8 rounded-md bg-lumo-fg px-3 text-[12px] font-medium text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                  >
                    {buttonLabel(proposal, state)}
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {plan.unavailable_capabilities.map((gap) => (
          <div
            key={gap.capability}
            className="rounded-md border border-lumo-warn/30 bg-lumo-warn/5 p-3 text-[12px] leading-relaxed text-lumo-fg-mid"
          >
            <span className="font-medium text-lumo-fg">
              {gap.capability_label}:
            </span>{" "}
            {gap.reason}
          </div>
        ))}
      </div>

      {error ? (
        <div className="mt-3 rounded-md border border-lumo-danger/30 bg-lumo-danger/10 px-3 py-2 text-[12px] text-lumo-danger">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-[11.5px] text-lumo-fg-low">
          {hasOAuth
            ? "Account connections redirect through the app's consent screen."
            : "You can manage installed apps from the Marketplace at any time."}
        </div>
        <div className="flex items-center gap-2">
          {autoInstallable.length > 1 ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void installAllAndContinue()}
              className="h-8 rounded-md border border-lumo-hair px-3 text-[12px] text-lumo-fg-mid hover:border-lumo-edge hover:text-lumo-fg disabled:opacity-60 transition-colors"
            >
              Install available
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled || hasOAuth || (autoInstallable.length > 0 && !allAutoInstalled)}
            onClick={continueMission}
            className="h-8 rounded-md bg-lumo-accent px-3 text-[12px] font-medium text-lumo-accent-ink disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function buttonLabel(
  proposal: JarvisMissionProposal,
  state: InstallState,
): string {
  if (state === "working") return "Working...";
  if (state === "done") return "Approved";
  if (proposal.action === "connect_oauth") return "Connect";
  if (proposal.action === "grant_lumo_id") return "Allow";
  return proposal.profile_fields_requested.length > 0 ? "Allow and install" : "Install";
}
