"use client";

/**
 * MissionCard — user-facing surface for an in-flight Sprint 3 mission.
 *
 * Purely presentational: takes a `MissionCardData` and renders the
 * state badge, intent text, progress bar, and step list. Wiring into
 * /workspace (the API hop + the cancel handler) lands in a follow-up
 * commit AFTER D5 ships, since D5 introduces the cancel endpoint that
 * the Cancel button calls.
 *
 * Visual language mirrors components/ProactiveMomentCard.tsx — same
 * `lumo-` design tokens, same accent-edge pattern, same button shapes —
 * with two deliberate divergences:
 *   1. More vertical breathing room (this card shows multiple steps).
 *   2. State-driven left-edge accent instead of urgency-driven, since
 *      missions don't carry an urgency tier.
 */

import {
  formatMissionRelative,
  isMissionCancellable,
  missionStateAccent,
  readableAgentTool,
  stepStatusIcon,
  summarizeMissionProgress,
  type MissionCardData,
} from "@/lib/mission-card-helpers";

interface Props {
  mission: MissionCardData;
  onCancel?: (id: string) => void | Promise<void>;
  busy?: boolean;
  /** When true, the full step list is rendered. Otherwise only the first 3. */
  expanded?: boolean;
}

const COLLAPSED_STEP_LIMIT = 3;

export function MissionCard({
  mission,
  onCancel,
  busy = false,
  expanded = false,
}: Props) {
  const accent = missionStateAccent(mission.state);
  const progress = summarizeMissionProgress(mission);
  const ago = formatMissionRelative(mission.created_at);
  const cancellable = isMissionCancellable(mission.state);
  const cancelDisabled = !onCancel || busy || !cancellable;

  const visibleSteps = expanded
    ? mission.steps
    : mission.steps.slice(0, COLLAPSED_STEP_LIMIT);
  const hiddenStepCount = Math.max(0, mission.steps.length - visibleSteps.length);

  return (
    <article
      className="relative overflow-hidden rounded-xl border border-lumo-hair bg-lumo-surface p-4 pl-5"
      data-mission-state={mission.state}
      data-mission-id={mission.id}
    >
      {/* State-coloured left-edge accent — same pattern as ProactiveMomentCard */}
      <span
        aria-hidden
        className={`absolute left-0 top-0 bottom-0 w-1 lumo-mission-state-edge ${accent.className}`}
      />

      {/* Header: state pill + step count + relative time */}
      <header className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 text-[10.5px] uppercase tracking-wide rounded px-1.5 py-0.5 lumo-mission-state-chip ${accent.className}`}
            aria-label={accent.label}
          >
            <span aria-hidden>{accent.icon}</span>
            {accent.label}
          </span>
          <span className="text-[11px] text-lumo-fg-mid whitespace-nowrap">
            {progress.succeeded} of {progress.total}{" "}
            {progress.total === 1 ? "step" : "steps"}
          </span>
        </div>
        {ago ? (
          <span className="text-[11px] text-lumo-fg-low whitespace-nowrap">{ago}</span>
        ) : null}
      </header>

      {/* Progress bar */}
      <div
        className="relative h-1.5 w-full rounded-full bg-lumo-elevated overflow-hidden mb-3"
        role="progressbar"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Mission progress"
      >
        <span
          className={
            "absolute left-0 top-0 bottom-0 transition-[width] duration-300 ease-out " +
            (mission.state === "executing" ? "animate-pulse" : "")
          }
          style={{
            width: `${progress.percent}%`,
            backgroundColor: `var(${accent.varName})`,
          }}
        />
      </div>

      {/* Intent text — the user's original request */}
      <p className="text-[14px] text-lumo-fg leading-relaxed mb-3 italic">
        “{mission.intent_text}”
      </p>

      {/* Step list */}
      {mission.steps.length > 0 ? (
        <div className="rounded-lg border border-lumo-hair bg-lumo-bg/40 p-2.5">
          <ul className="flex flex-col gap-1.5">
            {visibleSteps.map((step) => {
              const icon = stepStatusIcon(step.status);
              const label = readableAgentTool(step.agent_id, step.tool_name);
              const muted =
                step.status === "pending" || step.status === "skipped";
              return (
                <li
                  key={step.id}
                  className="flex items-center gap-2 text-[12.5px] leading-snug"
                  data-step-status={step.status}
                >
                  <span
                    aria-hidden
                    className={
                      "inline-flex w-4 justify-center text-[13px] " +
                      (step.status === "running"
                        ? "text-lumo-fg"
                        : step.status === "succeeded"
                          ? "text-emerald-400"
                          : step.status === "failed" ||
                              step.status === "rolled_back"
                            ? "text-red-400"
                            : "text-lumo-fg-low")
                    }
                  >
                    {icon.glyph}
                  </span>
                  <span
                    className={
                      "min-w-0 truncate " +
                      (muted ? "text-lumo-fg-low" : "text-lumo-fg-mid")
                    }
                  >
                    {label}
                  </span>
                  {step.status === "running" ? (
                    <span className="text-[11px] text-lumo-fg-low whitespace-nowrap">
                      running
                    </span>
                  ) : null}
                  {step.error_text ? (
                    <span
                      className="text-[11px] text-red-400 whitespace-nowrap"
                      title={step.error_text}
                    >
                      error
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {hiddenStepCount > 0 ? (
            <p className="mt-1.5 text-[11px] text-lumo-fg-low pl-6">
              +{hiddenStepCount} more {hiddenStepCount === 1 ? "step" : "steps"}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Footer: Cancel button (disabled placeholder until D5 ships the endpoint) */}
      <footer className="flex items-center justify-end gap-2 mt-3">
        <button
          type="button"
          onClick={onCancel ? () => void onCancel(mission.id) : undefined}
          disabled={cancelDisabled}
          title={onCancel ? undefined : "Cancel coming soon"}
          className="h-7 px-3 rounded-md border border-lumo-hair text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Cancelling…" : "Cancel"}
        </button>
      </footer>
    </article>
  );
}
