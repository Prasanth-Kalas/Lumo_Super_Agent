const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type TimeSinceInput = Date | string | number | null | undefined;

/**
 * Compact recents timestamp shared by the desktop rail and mobile drawer.
 * The labels intentionally mirror the iOS drawer's concise relative-time
 * posture without relying on locale-sensitive browser formatting.
 */
export function formatTimeSince(input: TimeSinceInput, now: Date = new Date()): string {
  const then = normalizeDate(input);
  if (!then) return "now";

  const elapsedMs = Math.max(0, now.getTime() - then.getTime());
  const totalSeconds = Math.floor(elapsedMs / SECOND_MS);
  if (totalSeconds < 5) return "now";

  if (elapsedMs < MINUTE_MS) {
    return `${totalSeconds} sec`;
  }

  const totalMinutes = Math.floor(elapsedMs / MINUTE_MS);
  const seconds = totalSeconds % 60;
  if (elapsedMs < HOUR_MS) {
    return joinParts([
      `${totalMinutes} min`,
      seconds > 0 ? `${seconds} sec` : null,
    ]);
  }

  const totalHours = Math.floor(elapsedMs / HOUR_MS);
  const minutes = totalMinutes % 60;
  if (elapsedMs < DAY_MS) {
    return joinParts([
      `${totalHours} hr`,
      minutes > 0 ? `${minutes} min` : null,
    ]);
  }

  const days = Math.floor(elapsedMs / DAY_MS);
  const hours = totalHours % 24;
  return joinParts([
    `${days} ${days === 1 ? "day" : "days"}`,
    hours > 0 ? `${hours} hr` : null,
  ]);
}

function normalizeDate(input: TimeSinceInput): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === "string" || typeof input === "number") {
    const parsed = new Date(input);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function joinParts(parts: Array<string | null>): string {
  return parts.filter(Boolean).join(", ");
}
