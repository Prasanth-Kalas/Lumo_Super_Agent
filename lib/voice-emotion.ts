export type VoiceEmotion =
  | "neutral"
  | "warm"
  | "reassuring"
  | "excited"
  | "celebratory";

export interface VoiceTuning {
  stability: number;
  similarity_boost: number;
  style: number;
}

const EXCITED_RE =
  /\b(great|awesome|amazing|love it|found|ready|let's go|perfect|yes|nice)\b/i;
const CELEBRATORY_RE =
  /\b(booked|confirmed|done|all set|success|approved|connected|completed)\b/i;
const REASSURING_RE =
  /\b(don't worry|no problem|blocked|failed|error|issue|missing|need your permission|confirm|before I)\b/i;

export function inferVoiceEmotion(text: string): VoiceEmotion {
  const normalized = text.trim();
  if (!normalized) return "neutral";
  if (CELEBRATORY_RE.test(normalized)) return "celebratory";
  if (REASSURING_RE.test(normalized)) return "reassuring";
  if (EXCITED_RE.test(normalized) || /!/.test(normalized)) return "excited";
  return "warm";
}

export function tuneVoiceForEmotion(
  base: VoiceTuning,
  emotion: VoiceEmotion,
): VoiceTuning {
  switch (emotion) {
    case "celebratory":
      return clampTuning({
        stability: base.stability - 0.08,
        similarity_boost: base.similarity_boost,
        style: base.style + 0.22,
      });
    case "excited":
      return clampTuning({
        stability: base.stability - 0.05,
        similarity_boost: base.similarity_boost,
        style: base.style + 0.16,
      });
    case "reassuring":
      return clampTuning({
        stability: base.stability + 0.12,
        similarity_boost: base.similarity_boost + 0.03,
        style: base.style + 0.04,
      });
    case "warm":
      return clampTuning({
        stability: base.stability + 0.03,
        similarity_boost: base.similarity_boost,
        style: base.style + 0.08,
      });
    case "neutral":
    default:
      return clampTuning(base);
  }
}

export function openAiEmotionInstructions(emotion: VoiceEmotion): string {
  const base =
    "Speak like Lumo: warm, concise, composed, and useful. Keep a natural conversational pace and finish every sentence cleanly.";
  switch (emotion) {
    case "celebratory":
      return `${base} Sound pleased and lightly celebratory, but never loud or theatrical.`;
    case "excited":
      return `${base} Add a little upbeat energy and momentum.`;
    case "reassuring":
      return `${base} Sound calm, patient, and reassuring. Slow down slightly on important caveats.`;
    case "warm":
      return `${base} Sound warm and conversational, like a capable concierge.`;
    case "neutral":
    default:
      return base;
  }
}

function clampTuning(input: VoiceTuning): VoiceTuning {
  return {
    stability: clamp01(input.stability),
    similarity_boost: clamp01(input.similarity_boost),
    style: clamp01(input.style),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
