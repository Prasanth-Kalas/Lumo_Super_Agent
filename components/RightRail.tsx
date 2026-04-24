"use client";

/**
 * RightRail — live operator HUD for the JARVIS dashboard.
 *
 * Panels (top to bottom, always rendered):
 *
 *   ACTIVE TRIP
 *     When the current turn has a structured-trip summary, show a
 *     compact card with the trip title, per-leg status icons, and
 *     total. Empty state when idle: "No active trip — book one and
 *     watch it fly."
 *
 *   VOICE
 *     Real-time status from VoiceMode — ready / listening / speaking /
 *     off. The dot pulses live. Hands-free toggle visible here too so
 *     the user can flip it without scrolling to the composer.
 *
 *   CONNECTED APPS
 *     Every specialist agent with its OAuth/status dot. Click through
 *     to /marketplace for the matching card.
 *
 *   SUGGESTIONS
 *     Contextual one-tap prompts. Default is the 4 starter trips; later
 *     we can swap for "based on your history" picks.
 *
 *   CLOCK / REGION
 *     The user's region + local time. Tiny detail, but it's the sort
 *     of ambient HUD thing that makes the shell feel alive.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

export interface LegStatusLite {
  order: number;
  agent_id: string;
  status:
    | "pending"
    | "in_flight"
    | "committed"
    | "failed"
    | "rolled_back"
    | "rollback_failed";
}

export interface ActiveTripView {
  trip_title?: string;
  total_amount?: string;
  currency?: string;
  legs: LegStatusLite[];
}

export type VoiceStateLite =
  | "off"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "unsupported"
  | "error";

export interface RightRailProps {
  /** The trip currently being confirmed or dispatched. Null when idle. */
  activeTrip: ActiveTripView | null;

  /** Voice state surfaced from VoiceMode. "off" when voice mode disabled. */
  voiceState: VoiceStateLite;
  voiceEnabled: boolean;
  handsFree: boolean;
  onToggleVoice: () => void;
  onToggleHandsFree: () => void;

  /** Region and device passed through from the shell. */
  userRegion: string;

  /** Called when the user taps a suggestion. */
  onSuggestion: (text: string) => void;
}

const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: "Flight to Vegas next Friday",
    prompt: "Find me a flight to Las Vegas next Friday for under $300.",
  },
  {
    label: "Pepperoni + Caesar, closest",
    prompt: "Order a pepperoni pizza and a Caesar salad from the closest place.",
  },
  {
    label: "Austin hotel, 2 nights, 6th St",
    prompt:
      "Find me a hotel in Austin for 2 nights, walkable to 6th Street, 4 stars or better.",
  },
  {
    label: "Austin trip: flight + hotel + dinner",
    prompt:
      "Plan a trip to Austin next weekend: flight from SFO, a hotel downtown, and dinner Friday night.",
  },
];

export default function RightRail(props: RightRailProps) {
  const {
    activeTrip,
    voiceState,
    voiceEnabled,
    handsFree,
    onToggleVoice,
    onToggleHandsFree,
    userRegion,
    onSuggestion,
  } = props;

  const [now, setNow] = useState<string>(fmtTime(new Date()));
  useEffect(() => {
    const t = setInterval(() => setNow(fmtTime(new Date())), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <aside className="hidden xl:flex h-full w-[320px] shrink-0 flex-col border-l border-lumo-hair bg-lumo-bg overflow-y-auto">
      {/* Active trip */}
      <Panel title="Active trip" mono>
        {activeTrip ? <ActiveTripCard trip={activeTrip} /> : <EmptyActiveTrip />}
      </Panel>

      {/* Voice */}
      <Panel title="Voice" mono>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <VoiceDot state={voiceState} enabled={voiceEnabled} />
            <div className="flex flex-col leading-tight">
              <span className="text-[12.5px] text-lumo-fg">
                {labelForVoice(voiceState, voiceEnabled)}
              </span>
              <span className="text-[10.5px] text-lumo-fg-low uppercase tracking-wider">
                {voiceEnabled ? (handsFree ? "hands-free" : "push to talk") : "text mode"}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggleVoice}
            aria-pressed={voiceEnabled}
            className={
              "rounded-full px-2.5 py-1 text-[11px] font-medium transition " +
              (voiceEnabled
                ? "bg-lumo-accent text-lumo-accent-ink"
                : "border border-lumo-hair text-lumo-fg-mid hover:text-lumo-fg")
            }
          >
            {voiceEnabled ? "On" : "Off"}
          </button>
        </div>
        {voiceEnabled ? (
          <button
            type="button"
            onClick={onToggleHandsFree}
            className="mt-2 w-full rounded-md border border-lumo-hair px-2 py-1.5 text-[11.5px] text-lumo-fg-mid hover:bg-lumo-elevated hover:text-lumo-fg transition-colors"
          >
            Switch to {handsFree ? "push-to-talk" : "hands-free"}
          </button>
        ) : null}
      </Panel>

      {/* Connected apps */}
      <Panel title="Connected apps" mono>
        <ul className="space-y-1">
          {[
            { id: "flight", label: "Flight Agent", icon: "✈", status: "connected" },
            { id: "hotel", label: "Hotel Agent", icon: "⌂", status: "connected" },
            { id: "food", label: "Food Agent", icon: "◉", status: "connected" },
            { id: "restaurant", label: "Reservation Agent", icon: "◆", status: "connected" },
          ].map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-lumo-elevated/60 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-lumo-accent text-[13px] w-4 text-center">
                  {a.icon}
                </span>
                <span className="text-[12.5px] text-lumo-fg">{a.label}</span>
              </div>
              <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-lumo-fg-low">
                <span className="h-1.5 w-1.5 rounded-full bg-lumo-accent shadow-[0_0_6px_rgba(94,234,172,0.6)]" />
                {a.status}
              </span>
            </li>
          ))}
        </ul>
        <Link
          href="/marketplace"
          className="mt-2 block text-center text-[11px] text-lumo-fg-low hover:text-lumo-fg underline-offset-4 hover:underline"
        >
          Browse marketplace →
        </Link>
      </Panel>

      {/* Suggestions */}
      <Panel title="Try asking" mono>
        <ul className="space-y-1.5">
          {SUGGESTIONS.map((s) => (
            <li key={s.label}>
              <button
                type="button"
                onClick={() => onSuggestion(s.prompt)}
                className="w-full text-left rounded-md border border-lumo-hair px-2.5 py-1.5 text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge transition-colors"
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      {/* Footer clock */}
      <div className="mt-auto border-t border-lumo-hair px-4 py-3">
        <div className="flex items-center justify-between text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low font-mono">
          <span>{userRegion}</span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1 w-1 rounded-full bg-lumo-accent animate-pulse" />
            {now}
          </span>
        </div>
      </div>
    </aside>
  );
}

// ──────────────────────────────────────────────────────────────────
// Panels
// ──────────────────────────────────────────────────────────────────

function Panel({
  title,
  mono,
  children,
}: {
  title: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="px-4 py-3 border-b border-lumo-hair">
      <div
        className={
          "mb-2 text-[10px] tracking-[0.16em] text-lumo-fg-low uppercase " +
          (mono ? "font-mono" : "")
        }
      >
        {title}
      </div>
      {children}
    </section>
  );
}

function EmptyActiveTrip() {
  return (
    <div className="rounded-lg border border-dashed border-lumo-hair px-3 py-4 text-center">
      <div className="text-[12px] text-lumo-fg-low">No active trip.</div>
      <div className="mt-1 text-[11px] text-lumo-fg-low/80">
        Book one and watch it dispatch in real time.
      </div>
    </div>
  );
}

function ActiveTripCard({ trip }: { trip: ActiveTripView }) {
  return (
    <div className="rounded-lg border border-lumo-hair bg-lumo-surface px-3 py-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12.5px] text-lumo-fg truncate">
            {trip.trip_title ?? "Trip in progress"}
          </div>
          <div className="mt-0.5 text-[10.5px] text-lumo-fg-low uppercase tracking-wider font-mono">
            {trip.legs.length} leg{trip.legs.length === 1 ? "" : "s"}
          </div>
        </div>
        {trip.total_amount ? (
          <div className="text-[13px] text-lumo-accent tabular-nums font-mono">
            {fmtMoney(trip.total_amount, trip.currency)}
          </div>
        ) : null}
      </div>
      <ul className="space-y-1">
        {trip.legs.map((leg) => (
          <li
            key={leg.order}
            className="flex items-center gap-2 text-[11.5px]"
            title={`${leg.agent_id} — ${leg.status}`}
          >
            <LegGlyph status={leg.status} />
            <span className="text-lumo-fg-mid flex-1 truncate">
              {agentDisplay(leg.agent_id)}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-lumo-fg-low font-mono">
              {shortStatus(leg.status)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LegGlyph({ status }: { status: LegStatusLite["status"] }) {
  const base = "inline-block h-2 w-2 rounded-full";
  const map: Record<LegStatusLite["status"], string> = {
    pending: `${base} bg-lumo-fg-low/40`,
    in_flight: `${base} bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.6)]`,
    committed: `${base} bg-lumo-accent shadow-[0_0_6px_rgba(94,234,172,0.6)]`,
    failed: `${base} bg-red-400`,
    rolled_back: `${base} bg-lumo-fg-low`,
    rollback_failed: `${base} bg-red-500 ring-2 ring-red-500/30`,
  };
  return <span className={map[status]} aria-label={status} />;
}

function VoiceDot({
  state,
  enabled,
}: {
  state: VoiceStateLite;
  enabled: boolean;
}) {
  if (!enabled) {
    return <span className="inline-block h-2 w-2 rounded-full bg-lumo-fg-low/30" />;
  }
  const cls =
    state === "listening"
      ? "bg-lumo-accent animate-pulse shadow-[0_0_10px_rgba(94,234,172,0.8)]"
      : state === "thinking"
      ? "bg-amber-400 animate-pulse"
      : state === "speaking"
      ? "bg-emerald-400 animate-pulse shadow-[0_0_10px_rgba(52,211,153,0.6)]"
      : state === "error"
      ? "bg-red-400"
      : "bg-lumo-accent/60";
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} aria-label={state} />;
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function agentDisplay(agent_id: string): string {
  const map: Record<string, string> = {
    "lumo.flight": "Flight",
    "flight-agent": "Flight",
    "lumo.hotel": "Hotel",
    "hotel-agent": "Hotel",
    "lumo.food": "Food",
    "food-agent": "Food",
    "lumo.restaurant": "Reservation",
    "restaurant-agent": "Reservation",
  };
  return map[agent_id] ?? agent_id;
}

function shortStatus(s: LegStatusLite["status"]): string {
  switch (s) {
    case "pending":
      return "queued";
    case "in_flight":
      return "booking";
    case "committed":
      return "done";
    case "failed":
      return "failed";
    case "rolled_back":
      return "refunded";
    case "rollback_failed":
      return "escalated";
  }
}

function labelForVoice(s: VoiceStateLite, enabled: boolean): string {
  if (!enabled) return "Voice off";
  switch (s) {
    case "listening":
      return "Listening…";
    case "thinking":
      return "Thinking…";
    case "speaking":
      return "Speaking…";
    case "error":
      return "Voice error";
    case "unsupported":
      return "Not supported";
    default:
      return "Ready";
  }
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtMoney(amount: string | number, currency?: string | null): string {
  try {
    const n = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(n)) return String(amount);
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${amount} ${currency ?? ""}`.trim();
  }
}
