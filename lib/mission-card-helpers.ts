/**
 * Pure helpers for the user-facing MissionCard component (Sprint 3 / K10).
 *
 * Mirrors the lib/proactive-moment-card-helpers.ts pattern: types + small
 * formatters extracted from the React component so they're testable from
 * a `.test.mjs` file with no DB / env / fetch / DOM.
 *
 * The card itself lives in components/MissionCard.tsx and renders a
 * `MissionCardData` object (mission row + per-step detail). Wiring the card
 * to /workspace lands in a separate follow-up commit AFTER D5 ships, so the
 * Cancel button can call the user-cancel endpoint D5 introduces.
 */
import type {
  MissionState,
  MissionStepStatus,
  Reversibility,
} from "./mission-execution-core.ts";

export type { MissionState, MissionStepStatus, Reversibility };

// ──────────────────────────────────────────────────────────────────────────
// Types — what the card consumes
// ──────────────────────────────────────────────────────────────────────────

export interface MissionCardStep {
  id: string;
  step_order: number;
  agent_id: string;
  tool_name: string;
  status: MissionStepStatus;
  reversibility: Reversibility;
  confirmation_card_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_text: string | null;
}

export interface MissionCardData {
  id: string;
  state: MissionState;
  intent_text: string;
  created_at: string;
  updated_at: string;
  steps: MissionCardStep[];
}

// ──────────────────────────────────────────────────────────────────────────
// State accent — colour + label + glyph per mission state
// ──────────────────────────────────────────────────────────────────────────

/**
 * Includes the union of `MissionState` (today) plus `rolling_back`, which
 * lands with D5. We accept the wider set so the card doesn't crash when
 * D5's migration adds the new state — the card just renders the matching
 * accent. Once the type union widens we can drop the cast.
 */
export type MissionStateOrRollingBack = MissionState | "rolling_back";

/**
 * CSS-variable-driven so the design system stays themeable. The variables
 * `--lumo-mission-state-{name}` are defined in app/globals.css alongside
 * the existing `--lumo-urgency-*` family. The card renders the colour via
 * `style={{ backgroundColor: \`var(\${varName})\` }}` so a future token
 * swap doesn't require touching the component.
 */
export function missionStateAccent(
  state: MissionStateOrRollingBack | string,
): {
  varName: string;
  label: string;
  icon: string;
} {
  switch (state) {
    case "draft":
      return { varName: "--lumo-mission-state-draft", label: "Drafting", icon: "✎" };
    case "awaiting_permissions":
      return {
        varName: "--lumo-mission-state-awaiting-permissions",
        label: "Needs permissions",
        icon: "🔑",
      };
    case "awaiting_user_input":
      return {
        varName: "--lumo-mission-state-awaiting-user-input",
        label: "Needs your input",
        icon: "?",
      };
    case "awaiting_confirmation":
      return {
        varName: "--lumo-mission-state-awaiting-confirmation",
        label: "Awaiting confirmation",
        icon: "⏸",
      };
    case "ready":
      return { varName: "--lumo-mission-state-ready", label: "Queued", icon: "•" };
    case "executing":
      return { varName: "--lumo-mission-state-executing", label: "In flight", icon: "⚡" };
    case "completed":
      return { varName: "--lumo-mission-state-completed", label: "Done", icon: "✓" };
    case "failed":
      return { varName: "--lumo-mission-state-failed", label: "Failed", icon: "✗" };
    case "rolling_back":
      return {
        varName: "--lumo-mission-state-rolling-back",
        label: "Rolling back",
        icon: "↺",
      };
    case "rolled_back":
      return {
        varName: "--lumo-mission-state-rolled-back",
        label: "Rolled back",
        icon: "↺",
      };
    default:
      return { varName: "--lumo-mission-state-draft", label: "Unknown", icon: "?" };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Progress summary — counts + percent for the progress bar
// ──────────────────────────────────────────────────────────────────────────

export interface MissionProgressSummary {
  total: number;
  succeeded: number;
  in_flight: number; // running + ready + awaiting_confirmation
  remaining: number; // pending
  failed: number;
  rolled_back: number;
  skipped: number;
  /** 0..100, computed from succeeded/total. */
  percent: number;
}

/**
 * Summarises a mission's steps into the small dashboard the card header
 * renders ("4 of 6 steps", progress bar). Order of the buckets matches
 * the card's left-to-right layout so the math is easy to reason about.
 *
 * `percent` floors the ratio so a partially-done mission never shows
 * "100%" until every step succeeds. Empty / missing steps → 0%.
 */
export function summarizeMissionProgress(
  mission: MissionCardData,
): MissionProgressSummary {
  const steps = Array.isArray(mission?.steps) ? mission.steps : [];
  const total = steps.length;

  let succeeded = 0;
  let in_flight = 0;
  let remaining = 0;
  let failed = 0;
  let rolled_back = 0;
  let skipped = 0;

  for (const step of steps) {
    switch (step?.status) {
      case "succeeded":
        succeeded += 1;
        break;
      case "running":
      case "ready":
      case "awaiting_confirmation":
        in_flight += 1;
        break;
      case "pending":
        remaining += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "rolled_back":
        rolled_back += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      default:
        // Unknown statuses count toward "remaining" so the bar still adds up.
        remaining += 1;
        break;
    }
  }

  const percent =
    total > 0 ? Math.max(0, Math.min(100, Math.floor((succeeded / total) * 100))) : 0;

  return { total, succeeded, in_flight, remaining, failed, rolled_back, skipped, percent };
}

// ──────────────────────────────────────────────────────────────────────────
// Time formatting — same shape as the proactive moment card
// ──────────────────────────────────────────────────────────────────────────

/**
 * Render a mission timestamp as a short relative string. Mirrors the
 * proactive-moment card's `formatMomentRelative` so the visual language
 * across in-flight surfaces stays consistent. Defensive against bad
 * input — never throws, returns "" on garbage.
 */
export function formatMissionRelative(
  iso: string,
  nowMs: number = Date.now(),
): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = nowMs - t;
  if (diffMs < 0) return "scheduled";
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Cancellability — does this state support a user-initiated cancel?
// ──────────────────────────────────────────────────────────────────────────

const CANCELLABLE_STATES: ReadonlySet<string> = new Set([
  "draft",
  "awaiting_permissions",
  "awaiting_user_input",
  "ready",
  "executing",
  "awaiting_confirmation",
]);

/**
 * Whether the Cancel button should be enabled for this mission state.
 * Terminal-success / terminal-failure / rolled-back states cannot be
 * cancelled — the work is already done or already undone.
 *
 * D5 introduces the `rolling_back` transient state, which is also not
 * cancellable (the rollback is itself a cancel-in-progress).
 */
export function isMissionCancellable(state: MissionStateOrRollingBack | string): boolean {
  return CANCELLABLE_STATES.has(state);
}

// ──────────────────────────────────────────────────────────────────────────
// Agent-tool human label
// ──────────────────────────────────────────────────────────────────────────

/**
 * Display names for the agent ids in config/agents.registry.json. Kept
 * small and explicit — we want "Lumo Hotels" in the user-facing card
 * even though the registry key is "hotel".
 */
const AGENT_DISPLAY: Record<string, string> = {
  "lumo-ml": "Lumo Intelligence",
  flight: "Lumo Flights",
  hotel: "Lumo Hotels",
  food: "Lumo Food",
  restaurant: "Lumo Restaurants",
  "open-weather": "Lumo Weather",
  "open-maps": "Lumo Maps",
  "open-attractions": "Lumo Attractions",
  "open-events": "Lumo Events",
  "open-ev-charging": "Lumo EV Charging",
};

/**
 * Tool names from `lumo-mission` arrive as `mission.<capability>` —
 * strip the prefix and turn underscores into spaces for a friendly label.
 */
function humanizeToolName(tool_name: string): string {
  if (!tool_name) return "";
  const stripped = tool_name.startsWith("mission.") ? tool_name.slice(8) : tool_name;
  return stripped.replace(/_+/g, " ").trim();
}

/**
 * "Lumo Hotels — book hotel" style human label for the step list.
 * Falls back to `${agent_id} · ${tool_name}` when the agent isn't in
 * AGENT_DISPLAY (so unknown community agents still render something
 * truthful instead of an empty cell).
 */
export function readableAgentTool(agent_id: string, tool_name: string): string {
  const friendly = AGENT_DISPLAY[agent_id];
  const tool = humanizeToolName(tool_name);
  if (friendly) {
    return tool ? `${friendly} — ${tool}` : friendly;
  }
  return `${agent_id} · ${tool_name}`;
}

/**
 * Per-step status icon. Used in the expanded step list.
 *   ✓  succeeded
 *   ⏵  running
 *   ○  pending / ready
 *   ⏸  awaiting_confirmation
 *   ↺  rolling_back
 *   ✗  failed / rolled_back
 *   ↷  skipped
 */
export function stepStatusIcon(status: MissionStepStatus | string): {
  glyph: string;
  label: string;
} {
  switch (status) {
    case "succeeded":
      return { glyph: "✓", label: "Done" };
    case "running":
      return { glyph: "⏵", label: "Running" };
    case "pending":
    case "ready":
      return { glyph: "○", label: "Pending" };
    case "awaiting_confirmation":
      return { glyph: "⏸", label: "Awaiting confirmation" };
    case "failed":
      return { glyph: "✗", label: "Failed" };
    case "rolled_back":
      return { glyph: "✗", label: "Rolled back" };
    case "skipped":
      return { glyph: "↷", label: "Skipped" };
    default:
      return { glyph: "○", label: String(status ?? "unknown") };
  }
}
