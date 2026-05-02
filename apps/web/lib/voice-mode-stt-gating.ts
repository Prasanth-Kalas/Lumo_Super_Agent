export const DEFAULT_VOICE_TTS_TAIL_GUARD_MS = 300;
export const MAX_VOICE_TTS_TAIL_GUARD_MS = 2_000;
export const MIN_VOICE_SPEAKING_WATCHDOG_MS = 30_000;
export const MAX_VOICE_EXPECTED_AUDIO_MS = 120_000;

export type VoiceModeMachinePhase =
  | "AGENT_THINKING"
  | "AGENT_SPEAKING"
  | "POST_SPEAKING_GUARD"
  | "LISTENING";

export type VoiceModeControlState =
  | "off"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "post_speaking_guard"
  | "unsupported"
  | "error";

export type VoiceModeActionKind =
  | "tap_to_talk"
  | "stop_listening"
  | "cancel_turn"
  | "stop_speaking"
  | "disabled";

export interface VoiceModeActionDescriptor {
  kind: VoiceModeActionKind;
  label: string;
  disabled: boolean;
}

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

export function voiceModeActionForState(
  state: VoiceModeControlState,
): VoiceModeActionDescriptor {
  switch (state) {
    case "idle":
    case "error":
      return { kind: "tap_to_talk", label: "Tap to talk", disabled: false };
    case "listening":
      return { kind: "stop_listening", label: "Stop", disabled: false };
    case "thinking":
      return { kind: "cancel_turn", label: "Cancel", disabled: false };
    case "speaking":
    case "post_speaking_guard":
      return { kind: "stop_speaking", label: "Stop", disabled: false };
    case "unsupported":
      return { kind: "disabled", label: "Unavailable", disabled: true };
    case "off":
      return { kind: "disabled", label: "Voice off", disabled: true };
  }
}

export function estimateVoiceAudioDurationMs(textLength: number): number {
  const safeLength = Math.max(0, Math.floor(textLength));
  if (safeLength === 0) return 0;
  return Math.min(
    MAX_VOICE_EXPECTED_AUDIO_MS,
    Math.max(1_000, safeLength * 90),
  );
}

export function voiceSpeakingWatchdogMs(textLength: number): number {
  return Math.max(
    estimateVoiceAudioDurationMs(textLength) + 500,
    MIN_VOICE_SPEAKING_WATCHDOG_MS,
  );
}
