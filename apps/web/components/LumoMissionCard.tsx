"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { logPreferenceEvent } from "@/lib/preference-events-client";

export interface LumoMissionScope {
  name: string;
  description: string;
  required: boolean;
}

export interface LumoMissionProposal {
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
  required_scopes: LumoMissionScope[];
  requires_payment: boolean;
  rank_score: number | null;
  rank_reasons: string[];
  risk_badge: LumoRiskBadge | null;
}

export interface LumoRankedRecommendation {
  agent_id: string;
  display_name: string;
  score: number;
  installed: boolean;
  reasons: string[];
  missing_scopes: string[];
}

export interface LumoRiskBadge {
  level: "low" | "medium" | "high" | "review_required";
  score: number;
  reasons: string[];
  mitigations: string[];
  source: "ml" | "fallback";
  latency_ms: number;
  error?: string;
}

export interface LumoOptimizedTripStop {
  id: string;
  label: string;
  category: string;
  sequence: number;
  arrival_minute: number;
  departure_minute: number;
  wait_minutes: number;
}

export interface LumoTripOptimization {
  status: "ok" | "fallback" | "infeasible";
  objective: "balanced" | "fastest" | "cheapest" | "comfort";
  route: LumoOptimizedTripStop[];
  dropped_stop_ids: string[];
  total_duration_minutes: number;
  total_cost_usd: number;
  total_distance_km: number;
  solver: string;
  source: "ml" | "fallback";
  latency_ms: number;
  error?: string;
}

export interface LumoUnavailableCapability {
  capability: string;
  capability_label: string;
  reason: string;
  requested_phrase: string;
}

export interface LumoMissionPlan {
  mission_id: string;
  original_request: string;
  mission_title: string;
  message: string;
  install_proposals: LumoMissionProposal[];
  ranked_recommendations?: LumoRankedRecommendation[];
  trip_optimization?: LumoTripOptimization | null;
  user_questions?: string[];
  confirmation_points?: string[];
  unavailable_capabilities: LumoUnavailableCapability[];
}

interface LumoMissionCardProps {
  plan: LumoMissionPlan;
  disabled?: boolean;
  onContinue: (text: string) => void;
}

type InstallState = "idle" | "working" | "done" | "error";

export function LumoMissionCard({
  plan,
  disabled = false,
  onContinue,
}: LumoMissionCardProps) {
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
  const missionContext = useMemo(
    () => missionPreferenceContext(plan),
    [plan],
  );

  useEffect(() => {
    const started = Date.now();
    logPreferenceEvent({
      surface: "mission_card",
      target_type: "mission_action",
      target_id: plan.mission_id,
      event_type: "impression",
      context: missionContext,
    });
    return () => {
      logPreferenceEvent({
        surface: "mission_card",
        target_type: "mission_action",
        target_id: plan.mission_id,
        event_type: "dwell",
        dwell_ms: Date.now() - started,
        context: missionContext,
      });
    };
  }, [missionContext, plan.mission_id]);

  async function installProposal(proposal: LumoMissionProposal): Promise<boolean> {
    if (disabled || stateByAgent[proposal.agent_id] === "working") return false;
    setError(null);
    logPreferenceEvent({
      surface: "mission_card",
      target_type: "agent",
      target_id: proposal.agent_id,
      event_type: "click",
      context: {
        action: proposal.action,
        mission_id: plan.mission_id,
        mission_title: plan.mission_title,
        rank_score: proposal.rank_score,
        risk_level: proposal.risk_badge?.level ?? null,
        requires_payment: proposal.requires_payment,
      },
    });

    if (proposal.action === "connect_oauth") {
      await startOAuth(proposal);
      return false;
    }

    setStateByAgent((prev) => ({ ...prev, [proposal.agent_id]: "working" }));
    try {
      const res = await fetch("/api/lumo/mission/install", {
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
    logPreferenceEvent({
      surface: "mission_card",
      target_type: "mission_action",
      target_id: `${plan.mission_id}:install_available`,
      event_type: "click",
      context: missionContext,
    });
    for (const proposal of autoInstallable) {
      if (stateByAgent[proposal.agent_id] === "done") continue;
      const ok = await installProposal(proposal);
      if (!ok) return;
    }
    if (!hasOAuth) continueMission();
  }

  async function startOAuth(proposal: LumoMissionProposal) {
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
    logPreferenceEvent({
      surface: "mission_card",
      target_type: "mission_action",
      target_id: `${plan.mission_id}:continue`,
      event_type: "click",
      context: missionContext,
    });
    onContinue(`Continue planning this mission with approved apps: ${plan.original_request}`);
  }

  return (
    <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
      <div className="flex flex-col gap-1">
        <div className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
          Lumo app permission
        </div>
        <div className="text-[15px] font-semibold tracking-tight text-lumo-fg">
          {plan.install_proposals.length > 0
            ? `Approve apps for ${plan.mission_title}`
            : `Review ${plan.mission_title}`}
        </div>
        <p className="text-[12.5px] leading-relaxed text-lumo-fg-mid">
          {plan.install_proposals.length > 0
            ? "I will only install or connect these apps after your approval. Profile details stay limited to the fields each app declares."
            : "One requested capability is not available in the approved marketplace yet. You can continue with the parts Lumo can safely handle."}
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
                    {proposal.risk_badge ? (
                      <RiskBadge badge={proposal.risk_badge} />
                    ) : null}
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-lumo-fg-mid">
                    {proposal.one_liner}
                  </p>
                  <p className="mt-2 text-[11.5px] leading-relaxed text-lumo-fg-low">
                    {proposal.permission_copy}
                  </p>
                  {proposal.rank_score !== null ? (
                    <p className="mt-1 text-[11.5px] leading-relaxed text-lumo-fg-low">
                      Rank {Math.round(proposal.rank_score * 100)}%
                      {proposal.rank_reasons.length > 0
                        ? ` · ${proposal.rank_reasons.slice(0, 2).join(" · ")}`
                        : ""}
                    </p>
                  ) : null}
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
                    onClick={() => {
                      logPreferenceEvent({
                        surface: "mission_card",
                        target_type: "agent",
                        target_id: proposal.agent_id,
                        event_type: "click",
                        context: {
                          action: "details",
                          mission_id: plan.mission_id,
                          mission_title: plan.mission_title,
                          rank_score: proposal.rank_score,
                          risk_level: proposal.risk_badge?.level ?? null,
                        },
                      });
                    }}
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

        {plan.ranked_recommendations?.length ? (
          <div className="rounded-md border border-lumo-hair bg-lumo-elevated/35 p-3">
            <div className="text-[12px] font-medium text-lumo-fg">
              Ranked app matches
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {plan.ranked_recommendations.slice(0, 6).map((agent) => (
                <span
                  key={agent.agent_id}
                  className="rounded-full bg-lumo-bg px-2 py-0.5 text-[10.5px] text-lumo-fg-low"
                  title={agent.reasons.join("; ")}
                >
                  {agent.display_name} · {Math.round(agent.score * 100)}%
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {plan.trip_optimization?.route?.length ? (
          <div className="rounded-md border border-lumo-hair bg-lumo-elevated/35 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[12px] font-medium text-lumo-fg">
                Optimized itinerary
              </div>
              <span className="rounded-full bg-lumo-bg px-2 py-0.5 text-[10.5px] text-lumo-fg-low">
                {plan.trip_optimization.objective} · {plan.trip_optimization.source}
              </span>
            </div>
            <ol className="mt-2 space-y-1.5 text-[11.5px] leading-relaxed text-lumo-fg-mid">
              {plan.trip_optimization.route.slice(0, 6).map((stop) => (
                <li key={`${stop.sequence}-${stop.id}`} className="flex gap-2">
                  <span className="w-[58px] shrink-0 text-lumo-fg-low">
                    {formatTripMinute(stop.arrival_minute)}
                  </span>
                  <span className="min-w-0">
                    {stop.label}
                    {stop.wait_minutes > 0 ? (
                      <span className="text-lumo-fg-low">
                        {" "}
                        · wait {stop.wait_minutes}m
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
            <div className="mt-2 text-[11px] text-lumo-fg-low">
              {Math.round(plan.trip_optimization.total_duration_minutes / 60)}h total ·{" "}
              {Math.round(plan.trip_optimization.total_distance_km)} km ·{" "}
              {plan.trip_optimization.solver}
            </div>
          </div>
        ) : null}

        {plan.user_questions?.length ? (
          <div className="rounded-md border border-lumo-hair bg-lumo-elevated/35 p-3">
            <div className="text-[12px] font-medium text-lumo-fg">
              Questions before execution
            </div>
            <ul className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-lumo-fg-mid">
              {plan.user_questions.slice(0, 4).map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {plan.confirmation_points?.length ? (
          <div className="rounded-md border border-lumo-hair bg-lumo-elevated/35 p-3">
            <div className="text-[12px] font-medium text-lumo-fg">
              Confirmation points
            </div>
            <ul className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-lumo-fg-mid">
              {plan.confirmation_points.slice(0, 4).map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        ) : null}
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

function formatTripMinute(minute: number): string {
  const day = Math.floor(minute / 1440) + 1;
  const withinDay = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(withinDay / 60);
  const mins = withinDay % 60;
  return `D${day} ${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function missionPreferenceContext(plan: LumoMissionPlan) {
  return {
    mission_id: plan.mission_id,
    mission_title: plan.mission_title,
    proposal_count: plan.install_proposals.length,
    ranked_count: plan.ranked_recommendations?.length ?? 0,
    unavailable_count: plan.unavailable_capabilities.length,
    question_count: plan.user_questions?.length ?? 0,
    confirmation_count: plan.confirmation_points?.length ?? 0,
    has_trip_optimization: Boolean(plan.trip_optimization?.route?.length),
    trip_optimization_source: plan.trip_optimization?.source ?? null,
  };
}

function buttonLabel(
  proposal: LumoMissionProposal,
  state: InstallState,
): string {
  if (state === "working") return "Working...";
  if (state === "done") return "Approved";
  if (proposal.action === "connect_oauth") return "Connect";
  if (proposal.action === "grant_lumo_id") return "Allow";
  return proposal.profile_fields_requested.length > 0 ? "Allow and install" : "Install";
}

function RiskBadge({ badge }: { badge: LumoRiskBadge }) {
  const classes =
    badge.level === "low"
      ? "border-lumo-ok/30 bg-lumo-ok/10 text-lumo-ok"
      : badge.level === "medium"
        ? "border-lumo-warn/35 bg-lumo-warn/10 text-lumo-warn"
        : badge.level === "high"
          ? "border-lumo-err/35 bg-lumo-err/10 text-lumo-err"
          : "border-lumo-hair bg-lumo-bg text-lumo-fg-low";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10.5px] ${classes}`}
      title={badge.reasons.join("; ")}
    >
      {badge.level === "review_required" ? "review risk" : `${badge.level} risk`}
    </span>
  );
}
