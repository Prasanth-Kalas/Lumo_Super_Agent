export type MemorySource = "explicit" | "inferred" | "behavioral" | string;
export type ConfidenceTone = "high" | "medium" | "low";

export function memorySourceLabel(source: MemorySource): string {
  switch (source) {
    case "explicit":
      return "Told by you";
    case "inferred":
      return "Inferred";
    case "behavioral":
      return "Learned from activity";
    default:
      return source ? titleize(source) : "Unknown source";
  }
}

export function memorySourceDescription(source: MemorySource): string {
  switch (source) {
    case "explicit":
      return "Lumo should treat this as user-provided memory.";
    case "inferred":
      return "Lumo inferred this from conversation context.";
    case "behavioral":
      return "Lumo derived this from repeated actions or events.";
    default:
      return "Source metadata is not available for this memory yet.";
  }
}

export function confidenceTone(confidence: number): ConfidenceTone {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

export function confidenceLabel(confidence: number): string {
  const pct = Math.round(clamp01(confidence) * 100);
  const tone = confidenceTone(confidence);
  if (tone === "high") return `${pct}% confidence`;
  if (tone === "medium") return `${pct}% confidence`;
  return `${pct}% needs review`;
}

export function formatMemoryRelative(
  iso: string | null | undefined,
  nowMs = Date.now(),
): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const diffMs = Math.max(0, nowMs - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function memoryHealthSummary(args: {
  factCount: number;
  highConfidenceCount: number;
  inferredCount: number;
  patternCount: number;
}): string {
  if (args.factCount === 0 && args.patternCount === 0) {
    return "No saved memories yet";
  }
  const parts = [
    `${args.factCount} fact${args.factCount === 1 ? "" : "s"}`,
    `${args.highConfidenceCount} high confidence`,
  ];
  if (args.inferredCount > 0) {
    parts.push(`${args.inferredCount} inferred`);
  }
  if (args.patternCount > 0) {
    parts.push(`${args.patternCount} pattern${args.patternCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
