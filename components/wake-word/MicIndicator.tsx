"use client";

/**
 * MicIndicator — the always-visible signal that the wake-word
 * listener is open.
 *
 * ADR-010 §6 mandates a visible "mic on" indicator any time the
 * microphone is held open, including the pre-wake passive listening
 * phase. This component is the BROWSER implementation of that
 * mandate. Mobile uses the OS-level mic indicator + an in-app badge;
 * this component is for the Lumo navbar and (when fixed) the floating
 * top-right viewport position.
 *
 * Rules baked into this component:
 *   - When `active=true`, the indicator MUST be visible. There is no
 *     `dismissable` prop. The user disables listening by clicking the
 *     indicator (which calls `onClickStop`), not by hiding the badge.
 *   - When the wake word fires, the parent flips `pulsing=true` for
 *     ~1 second; we render a one-shot pulse to signal the transition
 *     from passive listening to active capture.
 *   - When `paused` is one of the explicit reason strings (low
 *     battery, backgrounded tab, idle sleep), we render a calm
 *     "Listening paused" state instead of removing the indicator.
 *     The user always knows the wake-word feature's state.
 *
 * Accessibility:
 *   - role="status" with an aria-live polite region so screen readers
 *     announce state transitions ("Listening for wake word",
 *     "Listening paused — battery low").
 *   - The whole indicator is a real <button> when interactive so it's
 *     in the tab order and Enter/Space dismiss listening.
 *   - Visual pulse paired with sr-only "wake word detected" text on
 *     fire.
 *
 * Position: by default, fixed top-right of the viewport (z-30 so it
 * sits below modal dialogs but above page content). Pass
 * `position="inline"` to render it inline (e.g., inside the navbar).
 */

import { useEffect, useRef } from "react";

export type MicPausedReason =
  | "battery_low"
  | "backgrounded"
  | "idle_sleep"
  | "permission_revoked"
  | "other_app_using_mic";

export interface MicIndicatorProps {
  /** True while the mic is open — pre-wake or post-wake. */
  active: boolean;
  /** Set to a non-null reason while listening is suspended. The
   *  indicator stays visible but shifts to a paused tone. */
  paused?: MicPausedReason | null;
  /** Set to true for ~1 second when the wake word fires, then false. */
  pulsing?: boolean;
  /** Called when the user clicks the indicator to stop listening.
   *  Codex WAKE-1 wires this to the engine.stop() + writes
   *  interrupted_listening. */
  onClickStop?: () => void;
  /** "fixed" (default) places the indicator top-right of viewport.
   *  "inline" renders it as a flow element for embedding in headers. */
  position?: "fixed" | "inline";
}

const PAUSE_COPY: Record<MicPausedReason, string> = {
  battery_low: "Listening paused — battery low",
  backgrounded: "Listening paused — tab in background",
  idle_sleep: "Listening paused — idle for 30 minutes",
  permission_revoked: "Mic permission revoked — re-enable in settings",
  other_app_using_mic: "Listening paused — another app is using the mic",
};

export function MicIndicator(props: MicIndicatorProps) {
  const {
    active,
    paused = null,
    pulsing = false,
    onClickStop,
    position = "fixed",
  } = props;

  // Announce a one-shot when the wake word fires. The aria-live
  // region picks this up.
  const wakeAnnounceRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (pulsing && wakeAnnounceRef.current) {
      wakeAnnounceRef.current.textContent =
        "Wake word detected. Lumo is listening for your command.";
      const t = window.setTimeout(() => {
        if (wakeAnnounceRef.current) wakeAnnounceRef.current.textContent = "";
      }, 1500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [pulsing]);

  if (!active && !paused) return null;

  const wrapperPositional =
    position === "fixed"
      ? "fixed top-3 right-3 sm:top-4 sm:right-4 z-30"
      : "inline-flex";

  const isPaused = paused !== null;
  const stateLabel = isPaused
    ? PAUSE_COPY[paused]
    : pulsing
      ? "Wake word fired — capturing your command"
      : "Listening for 'Hey Lumo'";

  const interactive = typeof onClickStop === "function" && !isPaused;

  const Tag: "button" | "div" = interactive ? "button" : "div";
  const interactiveProps = interactive
    ? {
        type: "button" as const,
        onClick: onClickStop,
        "aria-label": `${stateLabel}. Click to stop.`,
      }
    : {};

  return (
    <div className={wrapperPositional}>
      <Tag
        {...interactiveProps}
        role="status"
        aria-live="polite"
        className={[
          "group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium shadow-sm backdrop-blur-md transition-colors",
          isPaused
            ? "border-lumo-warn/40 bg-lumo-warn/10 text-lumo-warn cursor-default"
            : pulsing
              ? "border-lumo-accent bg-lumo-accent text-lumo-accent-ink"
              : "border-lumo-accent/40 bg-lumo-bg/85 text-lumo-fg-high",
          interactive ? "cursor-pointer hover:bg-lumo-elevated focus-visible:ring-2 focus-visible:ring-lumo-accent focus-visible:outline-none" : "",
        ].join(" ")}
      >
        <span className="relative flex items-center justify-center">
          {/* Concentric pulse — visual heartbeat for screen-on users. */}
          {!isPaused ? (
            <span
              aria-hidden="true"
              className={[
                "absolute inline-block h-3 w-3 rounded-full",
                pulsing
                  ? "bg-lumo-accent-ink/40 animate-ping"
                  : "bg-lumo-accent/40 animate-ping",
              ].join(" ")}
            />
          ) : null}
          <span
            aria-hidden="true"
            className={[
              "relative inline-block h-2 w-2 rounded-full",
              isPaused
                ? "bg-lumo-warn"
                : pulsing
                  ? "bg-lumo-accent-ink"
                  : "bg-lumo-accent",
            ].join(" ")}
          />
        </span>
        <span>{stateLabel}</span>
        {interactive ? (
          <span className="text-[11px] text-lumo-fg-low group-hover:text-lumo-fg-mid">
            (stop)
          </span>
        ) : null}
        {/* Out-of-band wake-fire announcement for AT users. */}
        <span ref={wakeAnnounceRef} className="sr-only" aria-live="assertive" />
      </Tag>
    </div>
  );
}

export default MicIndicator;
