export const DEFAULT_VOICE_TTS_TAIL_GUARD_MS = 300;
export const MAX_VOICE_TTS_TAIL_GUARD_MS = 2_000;

export type VoiceModeMachinePhase =
  | "AGENT_THINKING"
  | "AGENT_SPEAKING"
  | "POST_SPEAKING_GUARD"
  | "LISTENING";

export type VoiceControlState =
  | "off"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "post_speaking_guard"
  | "unsupported"
  | "error";

export type VoicePrimaryAction =
  | "tap_to_talk"
  | "stop_listening"
  | "cancel"
  | "stop_speaking"
  | "disabled";

export function normalizeVoiceTtsTailGuardMs(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_VOICE_TTS_TAIL_GUARD_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_VOICE_TTS_TAIL_GUARD_MS;
  return Math.max(0, Math.min(MAX_VOICE_TTS_TAIL_GUARD_MS, Math.round(parsed)));
}

export function isMicPausedForVoicePhase(
  phase: VoiceModeMachinePhase,
): boolean {
  return phase === "AGENT_SPEAKING" || phase === "POST_SPEAKING_GUARD";
}

export interface CanResumeListeningInput {
  autoListenUnlocked: boolean;
  handsFree: boolean;
  userStoppedListening: boolean;
  enabled: boolean;
  busy: boolean;
  micPausedForTts: boolean;
}

export function canResumeListeningAfterTts(
  input: CanResumeListeningInput,
): boolean {
  return (
    input.autoListenUnlocked &&
    input.handsFree &&
    !input.userStoppedListening &&
    input.enabled &&
    !input.busy &&
    !input.micPausedForTts
  );
}

export function expectedTtsResumeSequence(
  handsFree: boolean,
): VoiceModeMachinePhase[] {
  return handsFree
    ? [
        "AGENT_THINKING",
        "AGENT_SPEAKING",
        "POST_SPEAKING_GUARD",
        "LISTENING",
      ]
    : ["AGENT_THINKING", "AGENT_SPEAKING", "POST_SPEAKING_GUARD"];
}

export function primaryActionForVoiceState(
  state: VoiceControlState,
): { kind: VoicePrimaryAction; label: string; disabled: boolean } {
  switch (state) {
    case "idle":
    case "error":
      return { kind: "tap_to_talk", label: "Tap to talk", disabled: false };
    case "listening":
      return { kind: "stop_listening", label: "Stop", disabled: false };
    case "thinking":
      return { kind: "cancel", label: "Cancel", disabled: true };
    case "speaking":
    case "post_speaking_guard":
      return { kind: "stop_speaking", label: "Stop", disabled: false };
    case "unsupported":
      return { kind: "disabled", label: "Unavailable", disabled: true };
    case "off":
    default:
      return { kind: "disabled", label: "Voice off", disabled: true };
  }
}
