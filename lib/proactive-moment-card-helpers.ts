/**
 * Pure helpers for the ProactiveMomentCard component. Extracted to a
 * separate module so the urgency-to-accent map, moment-type-to-icon
 * resolver, and relative-time formatter are testable without rendering
 * React.
 */

export type ProactiveMomentType =
  | "anomaly_alert"
  | "forecast_warning"
  | "pattern_observation"
  | "time_to_act"
  | "opportunity";

export type ProactiveMomentUrgency = "low" | "medium" | "high";

export interface ProactiveMoment {
  id: string;
  moment_type: ProactiveMomentType;
  title: string;
  body: string;
  evidence?: Record<string, unknown>;
  urgency: ProactiveMomentUrgency;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
}

/**
 * Maps urgency to a CSS variable name and a human-readable label.
 * The CSS variable is defined in app/globals.css and used for the
 * card's left-edge accent stripe + the urgency pill background.
 */
export function urgencyAccent(urgency: ProactiveMomentUrgency): {
  varName: string;
  label: string;
} {
  switch (urgency) {
    case "high":
      return { varName: "--lumo-urgency-high", label: "High urgency" };
    case "medium":
      return { varName: "--lumo-urgency-medium", label: "Worth checking" };
    case "low":
      return { varName: "--lumo-urgency-low", label: "FYI" };
  }
}

/**
 * Maps moment_type to a short icon glyph (single-character emoji or
 * text). The card uses this in a small badge next to the title.
 * We're not pulling in a heavy icon library; these glyphs render
 * reliably in any browser and convey the moment kind at a glance.
 */
export function momentTypeIcon(type: ProactiveMomentType): {
  glyph: string;
  label: string;
} {
  switch (type) {
    case "anomaly_alert":
      return { glyph: "⚡", label: "Anomaly" };
    case "forecast_warning":
      return { glyph: "📉", label: "Forecast" };
    case "pattern_observation":
      return { glyph: "🔁", label: "Pattern" };
    case "time_to_act":
      return { glyph: "⏰", label: "Act now" };
    case "opportunity":
      return { glyph: "✨", label: "Opportunity" };
  }
}

/**
 * Renders a ProactiveMoment timestamp as a short relative string.
 * "just now" / "5m ago" / "3h ago" / "yesterday" / "Apr 25"
 *
 * Returns the empty string for invalid input rather than throwing,
 * so the card never crashes on a malformed timestamp.
 */
export function formatMomentRelative(
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

/**
 * If the moment has a valid_until in the future, returns a short
 * "expires in X" string for the card footer. Returns null if no
 * deadline or already expired (caller hides the line).
 */
export function formatMomentExpiry(
  validUntil: string | null,
  nowMs: number = Date.now(),
): string | null {
  if (!validUntil) return null;
  const t = Date.parse(validUntil);
  if (Number.isNaN(t)) return null;
  const diffMs = t - nowMs;
  if (diffMs <= 0) return null;
  const h = Math.floor(diffMs / 3_600_000);
  if (h < 1) return "expires soon";
  if (h < 24) return `expires in ${h}h`;
  const d = Math.floor(h / 24);
  return `expires in ${d}d`;
}
