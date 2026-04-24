"use client";

/**
 * RightRail — live operator HUD.
 *
 * Redesigned (2026-04) to cut the duplication with LeftRail. The
 * previous "Connected apps" panel mirrored LeftRail's Agents list —
 * dead weight. "Try asking" duplicated the center hero's suggestions.
 * Both removed. What remains, and why:
 *
 *   ACTIVE TRIP
 *     The one thing LeftRail doesn't show — live leg-by-leg dispatch
 *     status. Bigger empty state: an ambient illustration and a
 *     friendly prompt, not just a dashed border.
 *
 *   VOICE
 *     Animated waveform when listening / speaking, calmer ring when
 *     idle. Bigger, more alive — the ears of the product.
 *
 *   RIGHT NOW
 *     Time-of-day aware smart suggestion ("It's almost dinner —
 *     want me to order?"). Calm by default, warm by context.
 *
 *   CLOCK
 *     Region + ticking local time, monospace. The ambient HUD.
 *
 * Warmer than the prior pass: subtle radial accent at the top,
 * rounded-2xl panels, more generous padding, typography up a notch.
 */

import { useEffect, useMemo, useState } from "react";

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
  activeTrip: ActiveTripView | null;
  voiceState: VoiceStateLite;
  voiceEnabled: boolean;
  /** True when Lumo's TTS is muted but the mic is still live. */
  voiceMuted: boolean;
  onToggleVoice: () => void;
  onToggleMuted: () => void;
  userRegion: string;
  onSuggestion: (text: string) => void;
}

export default function RightRail(props: RightRailProps) {
  const {
    activeTrip,
    voiceState,
    voiceEnabled,
    voiceMuted,
    onToggleVoice,
    onToggleMuted,
    userRegion,
    onSuggestion,
  } = props;

  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const smart = useMemo(() => smartSuggestion(now), [now]);

  return (
    <aside className="hidden xl:flex h-full w-[340px] shrink-0 flex-col border-l border-lumo-hair bg-lumo-bg relative overflow-hidden">
      {/* Ambient top glow — the premium HUD cue */}
      <div
        className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-64 w-[120%] rounded-full opacity-[0.18] blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--lumo-accent) 0%, transparent 60%)",
        }}
        aria-hidden
      />

      <div className="flex-1 overflow-y-auto relative z-10">
        {/* Active trip */}
        <Panel title="Active trip">
          {activeTrip ? (
            <ActiveTripCard trip={activeTrip} />
          ) : (
            <EmptyActiveTrip />
          )}
        </Panel>

        {/* Voice */}
        <Panel title="Voice">
          <VoicePanel
            state={voiceState}
            enabled={voiceEnabled}
            muted={voiceMuted}
            onToggle={onToggleVoice}
            onToggleMuted={onToggleMuted}
          />
        </Panel>

        {/* Smart suggestion (time-of-day aware) */}
        <Panel title="Right now">
          <button
            type="button"
            onClick={() => onSuggestion(smart.prompt)}
            className="group w-full text-left rounded-2xl border border-lumo-hair bg-gradient-to-br from-lumo-surface to-lumo-bg hover:from-lumo-elevated hover:to-lumo-surface transition-colors px-4 py-4"
          >
            <div className="flex items-start gap-3">
              <div className="shrink-0 h-9 w-9 rounded-full bg-lumo-accent/15 text-lumo-accent inline-flex items-center justify-center text-[18px] group-hover:bg-lumo-accent/25 transition-colors">
                {smart.icon}
              </div>
              <div className="min-w-0">
                <div className="text-[14px] text-lumo-fg leading-snug">
                  {smart.headline}
                </div>
                <div className="mt-1.5 text-[12.5px] text-lumo-fg-low leading-relaxed">
                  {smart.sub}
                </div>
              </div>
            </div>
            <div className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-lumo-accent group-hover:underline underline-offset-4">
              Tap to try
              <span aria-hidden>→</span>
            </div>
          </button>
        </Panel>
      </div>

      {/* Footer clock */}
      <div className="mt-auto border-t border-lumo-hair px-5 py-4 relative z-10">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-lumo-fg-low font-mono">
          <span>{userRegion}</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-lumo-accent animate-pulse" />
            {fmtTime(now)}
          </span>
        </div>
      </div>
    </aside>
  );
}

// ──────────────────────────────────────────────────────────────────
// Panels
// ──────────────────────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-5 py-4 border-b border-lumo-hair">
      <div className="mb-3 text-[11px] tracking-[0.18em] text-lumo-fg-low uppercase font-medium">
        {title}
      </div>
      {children}
    </section>
  );
}

function EmptyActiveTrip() {
  return (
    <div className="rounded-2xl border border-lumo-hair bg-gradient-to-br from-lumo-surface to-lumo-bg px-4 py-6 text-center">
      {/* Tiny orbital illustration — planes / loops around a dot */}
      <div className="mx-auto mb-3 relative h-12 w-12">
        <span className="absolute inset-0 rounded-full border border-lumo-accent/25" />
        <span className="absolute inset-2 rounded-full border border-lumo-accent/40" />
        <span className="absolute inset-4 rounded-full bg-lumo-accent/60 animate-pulse" />
      </div>
      <div className="text-[14px] text-lumo-fg">No active trip</div>
      <div className="mt-1.5 text-[12.5px] text-lumo-fg-low leading-relaxed">
        Book one and watch every leg
        <br />
        dispatch in real time.
      </div>
    </div>
  );
}

function ActiveTripCard({ trip }: { trip: ActiveTripView }) {
  const committed = trip.legs.filter((l) => l.status === "committed").length;
  const total = trip.legs.length;
  const pct = total > 0 ? Math.round((committed / total) * 100) : 0;

  return (
    <div className="rounded-2xl border border-lumo-hair bg-gradient-to-br from-lumo-surface to-lumo-bg px-4 py-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[14px] text-lumo-fg truncate font-medium">
            {trip.trip_title ?? "Trip in progress"}
          </div>
          <div className="mt-1 text-[11px] text-lumo-fg-low uppercase tracking-[0.14em] font-mono">
            {committed}/{total} booked
          </div>
        </div>
        {trip.total_amount ? (
          <div className="text-[15px] text-lumo-accent tabular-nums font-mono">
            {fmtMoney(trip.total_amount, trip.currency)}
          </div>
        ) : null}
      </div>

      {/* Progress bar */}
      <div className="h-1 rounded-full bg-lumo-elevated overflow-hidden">
        <div
          className="h-full bg-lumo-accent transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="space-y-1.5">
        {trip.legs.map((leg) => (
          <li
            key={leg.order}
            className="flex items-center gap-2.5 text-[13px]"
            title={`${leg.agent_id} — ${leg.status}`}
          >
            <LegGlyph status={leg.status} />
            <span className="text-lumo-fg-mid flex-1 truncate">
              {agentDisplay(leg.agent_id)}
            </span>
            <span className="text-[10.5px] uppercase tracking-wider text-lumo-fg-low font-mono">
              {shortStatus(leg.status)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VoicePanel({
  state,
  enabled,
  muted,
  onToggle,
  onToggleMuted,
}: {
  state: VoiceStateLite;
  enabled: boolean;
  muted: boolean;
  onToggle: () => void;
  onToggleMuted: () => void;
}) {
  const subLabel = !enabled
    ? "text mode"
    : muted
    ? "mic on · Lumo muted"
    : "hands-free";
  return (
    <div className="rounded-2xl border border-lumo-hair bg-gradient-to-br from-lumo-surface to-lumo-bg px-4 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <VoiceOrb state={state} enabled={enabled} />
          <div className="flex flex-col leading-tight">
            <span className="text-[14px] text-lumo-fg">
              {labelForVoice(state, enabled)}
            </span>
            <span className="text-[11px] text-lumo-fg-low uppercase tracking-[0.14em] mt-0.5">
              {subLabel}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={enabled}
          className={
            "rounded-full px-3 py-1.5 text-[12px] font-medium transition " +
            (enabled
              ? "bg-lumo-accent text-lumo-accent-ink shadow-[0_0_16px_rgba(94,234,172,0.35)]"
              : "border border-lumo-hair text-lumo-fg-mid hover:text-lumo-fg")
          }
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
      {enabled ? (
        <button
          type="button"
          onClick={onToggleMuted}
          aria-pressed={muted}
          className={
            "mt-3 w-full rounded-xl px-3 py-2 text-[12.5px] transition-colors inline-flex items-center justify-center gap-2 " +
            (muted
              ? "border border-lumo-hair text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated"
              : "border border-lumo-accent/40 text-lumo-accent hover:bg-lumo-accent/10")
          }
        >
          {muted ? "Unmute Lumo" : "Mute Lumo's voice"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Animated orb — calm ring when idle, pulsing glow when listening /
 * speaking. The ears/mouth of the product.
 */
function VoiceOrb({
  state,
  enabled,
}: {
  state: VoiceStateLite;
  enabled: boolean;
}) {
  const active =
    enabled && (state === "listening" || state === "speaking");
  const color =
    !enabled || state === "off" || state === "unsupported"
      ? "bg-lumo-fg-low/30"
      : state === "error"
      ? "bg-red-400"
      : state === "thinking"
      ? "bg-amber-400"
      : state === "speaking"
      ? "bg-emerald-400"
      : "bg-lumo-accent";
  return (
    <div className="relative h-10 w-10 shrink-0 flex items-center justify-center">
      {active ? (
        <>
          <span
            className={`absolute inset-0 rounded-full ${color} opacity-20 animate-ping`}
          />
          <span
            className={`absolute inset-1 rounded-full ${color} opacity-30 animate-pulse`}
          />
        </>
      ) : null}
      <span
        className={`relative h-3 w-3 rounded-full ${color} ${
          active ? "shadow-[0_0_12px_currentColor]" : ""
        }`}
        aria-label={enabled ? state : "off"}
      />
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

// ──────────────────────────────────────────────────────────────────
// Smart suggestion — time-of-day aware
// ──────────────────────────────────────────────────────────────────

function smartSuggestion(d: Date): {
  icon: string;
  headline: string;
  sub: string;
  prompt: string;
} {
  const h = d.getHours();
  const isFriday = d.getDay() === 5;

  if (h >= 6 && h < 10) {
    return {
      icon: "☀",
      headline: "Good morning.",
      sub: "Plan your day before it plans you.",
      prompt: "Help me plan a productive day — any meetings I should know about, and something easy for lunch near me.",
    };
  }
  if (h >= 10 && h < 14) {
    return {
      icon: "●",
      headline: "Lunch hour.",
      sub: "Want me to order something nearby?",
      prompt: "Order me a healthy lunch from the closest place that can deliver in 30 minutes.",
    };
  }
  if (h >= 14 && h < 17 && isFriday) {
    return {
      icon: "✈",
      headline: "It's Friday.",
      sub: "Weekend trip somewhere warm?",
      prompt: "Plan a weekend trip somewhere warm — flight and a nice hotel, departing tomorrow morning, back Sunday night.",
    };
  }
  if (h >= 17 && h < 22) {
    return {
      icon: "◆",
      headline: "Dinner time.",
      sub: "Book a table or order in — you pick.",
      prompt: "Find me a reservation somewhere nice for dinner tonight around 8pm for two, within 15 minutes of me.",
    };
  }
  if (h >= 22 || h < 6) {
    return {
      icon: "◗",
      headline: "Late night.",
      sub: "Need a ride, or a late bite?",
      prompt: "Order me something light to eat — anything still open that delivers.",
    };
  }
  return {
    icon: "⌂",
    headline: "Quiet afternoon.",
    sub: "Somewhere you've been meaning to visit?",
    prompt: "Plan a weekend getaway — flight and hotel — somewhere I haven't been in a while.",
  };
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
