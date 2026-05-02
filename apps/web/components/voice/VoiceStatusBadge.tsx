"use client";

/**
 * VoiceStatusBadge — small inline status pill that tells the user
 *   (a) whether their voice clone is enrolled, and
 *   (b) which TTS engine actually plays back when Lumo speaks.
 *
 * Designed for embedding in the voice settings page, the workspace
 * header voice menu, and read-only contexts (admin, support).
 *
 * Why both signals in one badge:
 *   ADR-012 §2.7 (use disclosure) requires that the user can tell, at
 *   a glance, whether their cloned voice or a stock voice will be used.
 *   Showing only "Voice clone: on" without the engine name means a
 *   user with a pending_deletion clone, or one whose self-hosted
 *   engine has fallen back to the stock provider, gets misled. The badge
 *   makes the actual TTS path visible.
 *
 * Variants are derived from props, not held internally — Codex VOICE-1
 * passes the user's voice_clones row + the active engine ID from the
 * orchestrator's TTS health endpoint.
 */

import { useMemo } from "react";

export type CloneStatus =
  | "not_enrolled"
  | "active"
  | "pending_deletion"
  | "failed"
  | "awaiting_legal_review";

export type TTSEngine =
  | "self_hosted_xtts"
  | "self_hosted_coqui"
  | "provider_fallback"
  | "stock_voice"
  | "unknown";

export interface VoiceStatusBadgeProps {
  cloneStatus: CloneStatus;
  /** The engine that will be used IF the clone path is active. If the
   *  clone is not enrolled, this is the engine for the stock voice. */
  ttsEngine: TTSEngine;
  /** Optional — name of the stock voice currently selected (e.g.,
   *  "Aurora"). Rendered when cloneStatus is not active. */
  stockVoiceName?: string | null;
  /** When true, render a one-line caption beneath the pill explaining
   *  which engine handles playback. Used in the settings header where
   *  there's room for the explainer. */
  showEngineCaption?: boolean;
}

interface BadgeView {
  label: string;
  tone: "neutral" | "ok" | "warn" | "error" | "info";
  description: string;
}

function deriveBadge(props: VoiceStatusBadgeProps): BadgeView {
  const { cloneStatus, ttsEngine, stockVoiceName } = props;
  switch (cloneStatus) {
    case "active":
      return {
        label: "Voice clone active",
        tone: "ok",
        description:
          ttsEngine === "provider_fallback"
            ? "Played back by our third-party fallback (self-hosted engine unavailable)."
            : "Played back by Lumo's self-hosted voice engine.",
      };
    case "pending_deletion":
      return {
        label: "Voice clone deleting",
        tone: "warn",
        description:
          "Your clone is being removed. Lumo is using your selected stock voice in the meantime.",
      };
    case "failed":
      return {
        label: "Voice clone failed",
        tone: "error",
        description:
          "The clone didn't finish enrolling. Re-record or delete to try again.",
      };
    case "awaiting_legal_review":
      return {
        label: "Voice cloning paused",
        tone: "info",
        description:
          "Voice cloning is paused while external legal review completes.",
      };
    case "not_enrolled":
    default:
      return {
        label: "Voice clone off",
        tone: "neutral",
        description: stockVoiceName
          ? `Lumo speaks in the stock voice "${stockVoiceName}".`
          : "Lumo speaks in a stock voice. You can enroll a clone in settings.",
      };
  }
}

const TONE_CLASSES: Record<BadgeView["tone"], string> = {
  ok: "border-lumo-ok/30 bg-lumo-ok/10 text-lumo-ok",
  warn: "border-lumo-warn/30 bg-lumo-warn/10 text-lumo-warn",
  error: "border-red-500/30 bg-red-500/10 text-red-500",
  info: "border-lumo-accent/30 bg-lumo-accent/10 text-lumo-accent",
  neutral: "border-lumo-hair bg-lumo-bg/40 text-lumo-fg-mid",
};

export function VoiceStatusBadge(props: VoiceStatusBadgeProps) {
  const view = useMemo(() => deriveBadge(props), [props]);
  return (
    <div className="inline-flex flex-col gap-1.5">
      <span
        className={[
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium",
          TONE_CLASSES[view.tone],
        ].join(" ")}
        role="status"
        aria-label={`${view.label}. ${view.description}`}
      >
        <Dot tone={view.tone} />
        {view.label}
      </span>
      {props.showEngineCaption ? (
        <span className="text-[11.5px] text-lumo-fg-low leading-snug">
          {view.description}
        </span>
      ) : null}
    </div>
  );
}

function Dot({ tone }: { tone: BadgeView["tone"] }) {
  // Match the dot tint to the pill so the screen-reader text is the
  // canonical signal but visual users still see a color cue.
  const fill = {
    ok: "currentColor",
    warn: "currentColor",
    error: "currentColor",
    info: "currentColor",
    neutral: "currentColor",
  }[tone];
  return (
    <span
      aria-hidden="true"
      className="inline-block h-1.5 w-1.5 rounded-full"
      style={{ backgroundColor: fill }}
    />
  );
}

export default VoiceStatusBadge;
