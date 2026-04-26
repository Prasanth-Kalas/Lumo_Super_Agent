"use client";

/**
 * RightRail — slimmed down to just the voice HUD.
 *
 * Previously held three panels (Active trip, What Lumo knows, Right
 * now). The user asked for a clean shell — those got cut. Trip
 * status now lives inline in the chat thread (TripConfirmationCard
 * already shows leg progress). Memory has its own /memory page.
 * Ambient context is still threaded into the system prompt; it
 * doesn't need a UI surface.
 *
 * The rail only renders when voice mode is on. When voice is off,
 * the entire column collapses so the chat takes the full width.
 *
 * The exported types (ActiveTripView, LegStatusLite) are kept
 * because the chat shell still constructs them for inline cards;
 * removing them would ripple into app/page.tsx and the trip card
 * components. They're declared here, just not consumed in this UI
 * anymore.
 */

import type { VoiceState } from "@/components/VoiceMode";

// ─── Types kept for callers (cards, shell) ─────────────────────

export interface LegStatusLite {
  order: number;
  agent_id: string;
  status: "pending" | "in_flight" | "committed" | "failed" | "rolled_back";
}

export interface ActiveTripView {
  trip_title?: string;
  total_amount?: string;
  currency?: string;
  legs: LegStatusLite[];
}

export type VoiceStateLite = VoiceState;

export interface RightRailProps {
  activeTrip: ActiveTripView | null;
  voiceState: VoiceStateLite;
  voiceEnabled: boolean;
  voiceMuted: boolean;
  onToggleVoice: () => void;
  onToggleMuted: () => void;
  userRegion: string;
  onSuggestion: (text: string) => void;
  memoryRefreshKey?: number | string;
}

// ─────────────────────────────────────────────────────────────

export default function RightRail({
  voiceEnabled,
  voiceState,
  voiceMuted,
  onToggleVoice,
  onToggleMuted,
}: RightRailProps) {
  // Hide the entire rail when voice is off. Center column gets the
  // width back automatically because this is hidden xl:flex below.
  if (!voiceEnabled) return null;

  return (
    <aside className="hidden xl:flex h-full w-[260px] shrink-0 flex-col border-l border-lumo-hair bg-lumo-surface">
      <div className="p-4 border-b border-lumo-hair">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
          Voice
        </div>
        <div className="mt-2 flex items-center gap-2">
          <StateDot state={voiceState} />
          <span className="text-[13px] text-lumo-fg">
            {labelFor(voiceState)}
          </span>
        </div>
      </div>

      <div className="p-4 space-y-2">
        <button
          type="button"
          onClick={onToggleMuted}
          className={
            "w-full inline-flex items-center justify-between rounded-md px-3 py-2 text-[12.5px] transition-colors " +
            (voiceMuted
              ? "border border-lumo-hair text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated"
              : "border border-g-blue/40 text-g-blue hover:bg-g-blue/10")
          }
        >
          <span>{voiceMuted ? "Lumo muted" : "Lumo speaking"}</span>
          <span className="text-[10.5px] text-lumo-fg-low uppercase tracking-wide">
            {voiceMuted ? "Tap to unmute" : "Tap to mute"}
          </span>
        </button>

        <button
          type="button"
          onClick={onToggleVoice}
          className="w-full inline-flex items-center justify-center rounded-md border border-lumo-hair px-3 py-2 text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
        >
          Turn voice off
        </button>
      </div>

      <div className="mt-auto p-4 text-[11px] text-lumo-fg-low leading-relaxed">
        Tap and hold to speak, or just talk. Lumo responds when you
        stop.
      </div>
    </aside>
  );
}

function StateDot({ state }: { state: VoiceState }) {
  const cls =
    state === "listening"
      ? "bg-g-blue animate-pulse"
      : state === "speaking"
        ? "bg-g-green animate-pulse"
        : state === "thinking"
          ? "bg-g-yellow animate-pulse"
          : state === "error"
            ? "bg-g-red"
            : "bg-lumo-fg-low/50";
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} aria-hidden />;
}

function labelFor(s: VoiceState): string {
  switch (s) {
    case "off":
      return "Off";
    case "idle":
      return "Ready";
    case "listening":
      return "Listening";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "unsupported":
      return "Not supported";
    case "error":
      return "Error";
  }
}
