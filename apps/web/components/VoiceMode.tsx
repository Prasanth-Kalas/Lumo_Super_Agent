"use client";

/**
 * VoiceMode — hands-free speaking interface for Lumo.
 *
 * Product framing: users driving can't tap a keyboard. They wear
 * AirPods, say "book a flight to Vegas next Friday", and expect Lumo
 * to come back in voice. This component owns:
 *
 *   - Browser-native STT via webkitSpeechRecognition (Chromium,
 *     Safari, Edge). When the user speaks, we capture their final
 *     transcript and hand it back to the shell via `onUserUtterance`.
 *
 *   - Premium streamed TTS via /api/tts, with browser-native
 *     speechSynthesis as the reliable fallback. As the agent streams
 *     text frames, the shell accumulates assistant text and passes it
 *     here via `spokenText`; we chunk on sentence boundaries so Lumo
 *     starts speaking before the full response is complete.
 *
 *   - A clear visual state machine — idle / listening / thinking /
 *     speaking / error — so even a glance at the screen conveys
 *     where we are. The Lumo affordance.
 *
 *   - Hands-free mode: after TTS finishes speaking, auto-restart
 *     listening. Click-to-talk mode: user taps the mic each turn.
 *
 *   - Graceful degradation: no SpeechRecognition? The component
 *     renders a one-line "not supported — use text" and disables
 *     itself. No throws.
 *
 * NOT in v1:
 *   - Multi-lingual.
 *
 * The component is self-contained — it doesn't know about SSE,
 * summaries, or routing. That separation means the shell can swap
 * this implementation for OpenAI Realtime in v3 without reworking
 * chat state.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { startBargeInMonitor, type BargeInHandle } from "@/lib/barge-in";
import { startWakeWord, type WakeWordHandle } from "@/lib/wake-word";
import {
  createChunkedAudioPlayer,
  type ChunkedAudioPlayer,
} from "@/lib/streaming-audio";
import { getSelectedVoiceId } from "@/lib/voice-catalog";
import {
  nextSpeakableChunks,
  finalSpeakableChunks,
  chooseSilenceWindow as chooseSilenceWindowPure,
  silenceDecision,
  DEFAULT_SILENCE,
} from "@/lib/voice-chunking";
import {
  browserProsodyForEmotion,
  inferVoiceEmotion,
  type VoiceEmotion,
} from "@/lib/voice-emotion";
import {
  canResumeListeningAfterTts,
  isMicPausedForVoicePhase,
  normalizeVoiceTtsTailGuardMs,
  primaryActionForVoiceState,
  type VoiceModeMachinePhase,
} from "@/lib/voice-mode-stt-gating";

// How long to honor a "premium TTS unavailable" verdict before
// re-probing. Tuned for transient upstream issues (quota, brief 5xx,
// network glitch) — 60 s is
// long enough to avoid thrash on every chunk, short enough to recover
// within a single conversation once upstream heals.
const PREMIUM_TTS_COOLDOWN_MS = 60_000;
const PREMIUM_TTS_TIMEOUT_MS = 10_000;
const BROWSER_TTS_START_TIMEOUT_MS = 2_500;
const BROWSER_TTS_DONE_TIMEOUT_MS = 45_000;
const RECORDED_STT_MAX_MS = 30_000;
const TTS_TAIL_GUARD_MS = normalizeVoiceTtsTailGuardMs(
  process.env.NEXT_PUBLIC_LUMO_VOICE_TTS_TAIL_GUARD_MS ??
    process.env.LUMO_VOICE_TTS_TAIL_GUARD_MS,
);
const RECORDED_STT_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];
const BARGE_IN_ENABLED =
  process.env.NEXT_PUBLIC_LUMO_BARGE_IN_ENABLED === "true";

// ─── Types for the Web Speech API that TS doesn't ship ────────────
// We declare only what we touch. See:
// https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [i: number]: {
      isFinal: boolean;
      [j: number]: { transcript: string };
      length: number;
    };
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

export type VoiceState =
  | "off"         // voice mode is toggled off entirely
  | "idle"        // waiting for the user to start / finish speaking
  | "listening"   // STT is active
  | "thinking"   // user's message is in flight to /api/chat
  | "speaking"   // TTS is playing an assistant reply
  | "post_speaking_guard" // TTS tail decay; mic remains muted briefly
  | "unsupported"// browser doesn't expose Web Speech
  | "error";     // transient error; auto-recovers on next action

export interface VoiceModeProps {
  /** Master on/off from the shell. Shell persists across sessions. */
  enabled: boolean;
  onToggle: (enabled: boolean) => void;

  /**
   * Hands-free mode: after TTS finishes, auto-restart listening.
   * Defaults to always-on when voice is enabled; the push-to-talk
   * alternative was removed in the voice UX cleanup (task #85) —
   * the driving-first product only wants the conversational loop.
   * Prop kept for API compatibility; value ignored when false.
   */
  handsFree: boolean;
  onHandsFreeToggle: (handsFree: boolean) => void;

  /**
   * Mute Lumo's voice. When true, STT keeps working (Lumo still
   * hears the user) but TTS is suppressed so the assistant
   * doesn't speak aloud. Use case: user wants hands-free input
   * but is in a quiet place and doesn't want Lumo talking back.
   */
  muted: boolean;
  onMutedToggle: (muted: boolean) => void;

  /**
   * Called when the user finishes speaking (STT gives us a final
   * transcript). The shell will dispatch this as a user message.
   */
  onUserUtterance: (text: string) => void;

  /**
   * Full accumulated assistant text for the current in-flight
   * response. The component monitors it and speaks incrementally:
   * when a sentence boundary arrives, the new tail is queued.
   * Reset to empty string when the agent turn starts.
   */
  spokenText: string;

  /** True while the shell's fetch('/api/chat') is in flight. */
  busy: boolean;

  /**
   * Optional mirror of internal state so the shell (or right rail
   * HUD) can render its own "Listening…" / "Speaking…" indicator
   * without owning the state machine. Called on every transition.
   */
  onStateChange?: (state: VoiceState) => void;
}

// nextSpeakableChunk extracted to lib/voice-chunking.ts so it's unit-
// testable without standing up React + JSDOM. Imported above.

/**
 * Minimal TTS-safe transform of plain text. Strip markdown leftovers
 * and emojis on the client so we don't rely on the server-side
 * voice-format lib being imported here (bundle weight). Kept in sync
 * with lib/voice-format.ts::toSpeakable at the rule level.
 */
function toSpeakable(md: string): string {
  if (!md) return "";
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/\S+/g, "a link");
  s = s.replace(/^#+\s*/gm, "");
  s = s.replace(/^\s*[-*•]\s+/gm, ". ");
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Pick the best available TTS voice. Preferences: en-US / en-GB
 * female voice ("Samantha" on Apple, "Google UK English Female" on
 * Chrome), fall back to any en voice, fall back to default.
 */
function pickVoice(
  voices: SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const preferredNames = [
    "Samantha",
    "Google US English",
    "Google UK English Female",
    "Microsoft Aria Online (Natural)",
    "Microsoft Jenny Online (Natural)",
    "Karen",
    "Moira",
    "Tessa",
  ];
  for (const name of preferredNames) {
    const match = voices.find((v) => v.name === name);
    if (match) return match;
  }
  const enUS = voices.find((v) => v.lang === "en-US");
  if (enUS) return enUS;
  const enAny = voices.find((v) => v.lang.startsWith("en"));
  if (enAny) return enAny;
  return voices[0] ?? null;
}

function canRecordFallback(): boolean {
  if (typeof window === "undefined") return false;
  if (!navigator?.mediaDevices?.getUserMedia) return false;
  return typeof window.MediaRecorder !== "undefined";
}

function preferredRecordingMimeType(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const MR = window.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") return undefined;
  return RECORDED_STT_MIME_TYPES.find((type) => MR.isTypeSupported(type));
}

export default function VoiceMode(props: VoiceModeProps) {
  const {
    enabled,
    onToggle,
    handsFree,
    onHandsFreeToggle,
    muted,
    onMutedToggle,
    onUserUtterance,
    spokenText,
    busy,
  } = props;

  const [state, setState] = useState<VoiceState>(enabled ? "idle" : "off");
  const [interim, setInterim] = useState<string>(""); // what user is currently saying
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentEmotion, setCurrentEmotion] = useState<VoiceEmotion>("warm");

  // Mirror every transition to the shell-provided callback so the
  // right-rail HUD can render a matching dot. Ref-latched so a
  // callback change doesn't retrigger the effect.
  const onStateChangeRef = useRef(props.onStateChange);
  useEffect(() => {
    onStateChangeRef.current = props.onStateChange;
  }, [props.onStateChange]);
  useEffect(() => {
    onStateChangeRef.current?.(state);
  }, [state]);

  // Refs — mutable state that shouldn't re-render.
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recorderChunksRef = useRef<BlobPart[]>([]);
  const recorderSubmitRef = useRef<boolean>(false);
  const recorderStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  // Premium TTS state — starts "unknown", flips to "available" after
  // first successful /api/tts call, or "unavailable" after a network
  // or non-2xx response. Crucially NOT a session-permanent lock: we
  // hold the "unavailable" verdict for `PREMIUM_TTS_COOLDOWN_MS` then
  // quietly re-probe on the next speech turn. This means a transient
  // upstream blip (timeout, quota, short outage) no longer condemns the
  // rest of the session to browser TTS — we recover as
  // soon as the upstream does.
  const premiumStatusRef = useRef<"unknown" | "available" | "unavailable">(
    "unknown",
  );
  const premiumUnavailableSinceRef = useRef<number>(0);
  // Active premium TTS session for the in-flight assistant turn.
  // Deepgram returns one MP3 response per sentence chunk; this
  // player keeps a single MediaSource alive and appends every chunk
  // before ending the stream. Mute / cancel / barge-in call .stop().
  const activeStreamRef = useRef<ChunkedAudioPlayer | null>(null);
  const ttsAbortControllerRef = useRef<AbortController | null>(null);
  // Keep the current browser-native utterance strongly referenced.
  // Some WebKit/Chromium builds can garbage-collect a local-only
  // SpeechSynthesisUtterance before it speaks, which presents as
  // "TTS is silent" with no console error.
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  // Serialized TTS queue. The root cause of "multiple voices"
  // playing over each other was that every spokenText change that
  // produced a speakable chunk called speakWithFallback() directly,
  // kicking off a fresh /api/tts fetch + new <Audio> element without
  // waiting for the previous one to finish. Audio elements don't
  // cooperate — they all just play. The fix: every caller enqueues,
  // and a single worker (runTtsWorker) drains the queue one chunk at
  // a time, awaiting each chunk's playback before starting the next.
  // Mute, turn-reset, and mode-exit clear the queue AND stop the
  // active stream so nothing lingers.
  // Queue entries carry their own onEnd so we can fire the right
  // callback when the *last* chunk of a turn finishes. The earlier
  // design used a single shared onFinalChunkEnd passed to the
  // worker — which silently dropped every enqueuer after the
  // first. That's why state got stuck at "speaking" after long
  // replies: tail-flush's "setState idle + startListening"
  // callback was never invoked because the worker was already
  // running with the chunk-effect's callback.
  interface TtsQueueEntry {
    text: string;
    onEnd?: () => void;
    final?: boolean;
  }
  const ttsQueueRef = useRef<TtsQueueEntry[]>([]);
  const ttsWorkerRunningRef = useRef<boolean>(false);
  const ttsTurnIdRef = useRef<number>(0); // bumped on every fresh turn
  // Mirror of `busy` for the onEnd callbacks to consult. Captured
  // closures otherwise read the busy value at enqueue time, which
  // is usually true — so after all TTS drained we'd incorrectly
  // setState("thinking") instead of transitioning to idle.
  const busyRef = useRef<boolean>(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const spokenSoFarRef = useRef<number>(0); // index into spokenText already sent to TTS
  const lastSpokenTextRef = useRef<string>(spokenText);
  const userStoppedListeningRef = useRef<boolean>(false); // user intent to be off
  // User-initiated Stop while Lumo is mid-speech sets this true.
  // The TTS feeder effects skip enqueuing while it's true so the
  // assistant's still-streaming response doesn't keep producing
  // audio in the background. Resets when a new agent turn starts
  // (spokenText shrinks) or when the user explicitly taps to talk.
  const userStoppedTtsRef = useRef<boolean>(false);
  const wantHandsFreeRef = useRef<boolean>(handsFree);
  const enabledRef = useRef<boolean>(enabled);
  const autoListenUnlockedRef = useRef<boolean>(false);
  const finalBufferRef = useRef<string>("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsTailGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const voicePhaseRef = useRef<VoiceModeMachinePhase>("LISTENING");
  const ttsMicPausedRef = useRef<boolean>(false);
  useEffect(() => {
    wantHandsFreeRef.current = handsFree;
  }, [handsFree]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // J5 — barge-in: a second mic pipeline that stays open while TTS is
  // playing. When it detects user speech, we cancel TTS and pivot to
  // STT. Lives only while state === "speaking" so we don't hold a
  // mic open unnecessarily.
  const bargeInRef = useRef<BargeInHandle | null>(null);
  // J5 — wake word: optional Porcupine scaffold. active=false when no
  // access key is present, so this is a no-op in most environments.
  const wakeWordRef = useRef<WakeWordHandle | null>(null);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const setVoiceMachinePhase = useCallback((phase: VoiceModeMachinePhase) => {
    voicePhaseRef.current = phase;
    ttsMicPausedRef.current = isMicPausedForVoicePhase(phase);
  }, []);

  const clearTtsTailGuard = useCallback(() => {
    if (ttsTailGuardTimerRef.current) {
      clearTimeout(ttsTailGuardTimerRef.current);
      ttsTailGuardTimerRef.current = null;
    }
  }, []);

  const pauseActiveMicFeedForTts = useCallback(() => {
    clearSilenceTimer();
    finalBufferRef.current = "";
    setInterim("");

    const rec = recognitionRef.current;
    if (rec) {
      recognitionRef.current = null;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }

    const recorder = recorderRef.current;
    if (recorder) {
      recorderSubmitRef.current = false;
      recorderRef.current = null;
      try {
        if (recorder.state === "recording") recorder.stop();
      } catch {
        /* ignore */
      }
    }
    const stream = recorderStreamRef.current;
    recorderStreamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
  }, [clearSilenceTimer]);

  const beginTtsMicGate = useCallback(() => {
    clearTtsTailGuard();
    setVoiceMachinePhase("AGENT_SPEAKING");
    pauseActiveMicFeedForTts();
  }, [clearTtsTailGuard, pauseActiveMicFeedForTts, setVoiceMachinePhase]);

  // ─── Capability detection ────────────────────────────────────
  const supportedRef = useRef<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const Ctor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
    supportedRef.current =
      "speechSynthesis" in window && (Boolean(Ctor) || canRecordFallback());
    if (!supportedRef.current) {
      setState("unsupported");
    }
  }, []);

  // ─── Voice catalog ready ─────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const refreshVoices = () => {
      const vs = window.speechSynthesis.getVoices();
      voiceRef.current = pickVoice(vs);
    };
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // ─── Premium TTS (Deepgram via /api/tts) ──────────────────────
  //
  // Declared BEFORE the STT lifecycle because startListening needs
  // to call cancelTts() to stop any in-flight audio when the user
  // begins speaking. The functions below are all useCallback-stable
  // refs so the dependency arrays downstream don't trigger
  // unnecessary re-renders.
  const appendPremiumTts = useCallback(
    async (
      text: string,
      emotion: VoiceEmotion,
      onStart: () => void,
    ): Promise<"appended" | "unavailable" | "aborted"> => {
      if (typeof window === "undefined") return "unavailable";

      if (premiumStatusRef.current === "unavailable") {
        const sinceMs = Date.now() - premiumUnavailableSinceRef.current;
        if (sinceMs < PREMIUM_TTS_COOLDOWN_MS) {
          return "unavailable";
        }
        premiumStatusRef.current = "unknown";
      }

      let res: Response;
      const controller = new AbortController();
      ttsAbortControllerRef.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), PREMIUM_TTS_TIMEOUT_MS);
      try {
        res = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            text,
            voice_id: getSelectedVoiceId(),
            emotion,
          }),
        });
      } catch (e) {
        console.warn("[voice] /api/tts network failure, falling back:", e);
        premiumStatusRef.current = "unavailable";
        premiumUnavailableSinceRef.current = Date.now();
        return "unavailable";
      } finally {
        window.clearTimeout(timeout);
        if (ttsAbortControllerRef.current === controller) {
          ttsAbortControllerRef.current = null;
        }
      }

      if (!res.ok || !res.body) {
        if (res.status === 503) {
          const payload = (await res.json().catch(() => null)) as {
            retryable?: unknown;
          } | null;
          if (payload?.retryable === true) {
            setErrorMessage("Voice unavailable — chat continues");
          }
        }
        console.info(
          "[voice] premium TTS unavailable (status",
          res.status + "), using browser fallback; will re-probe in",
          Math.round(PREMIUM_TTS_COOLDOWN_MS / 1000) + "s",
        );
        premiumStatusRef.current = "unavailable";
        premiumUnavailableSinceRef.current = Date.now();
        return "unavailable";
      }

      premiumStatusRef.current = "available";
      premiumUnavailableSinceRef.current = 0;
      const responseEmotion = parseVoiceEmotion(
        res.headers.get("x-lumo-tts-emotion"),
      );
      setCurrentEmotion(responseEmotion ?? inferVoiceEmotion(text));

      let handle = activeStreamRef.current;
      if (!handle) {
        try {
          handle = createChunkedAudioPlayer({
            onStart: () => onStart(),
            onEnd: (reason) => {
              if (activeStreamRef.current === handle) {
                activeStreamRef.current = null;
              }
              if (reason === "error") {
                premiumStatusRef.current = "unavailable";
                premiumUnavailableSinceRef.current = Date.now();
              }
            },
          });
          activeStreamRef.current = handle;
        } catch (err) {
          console.warn("[voice] premium TTS playback failed, falling back:", err);
          premiumStatusRef.current = "unavailable";
          premiumUnavailableSinceRef.current = Date.now();
          return "unavailable";
        }
      }

      const appended = await handle.appendResponse(res);
      if (appended === "appended") return "appended";
      if (appended === "stopped") return "aborted";
      premiumStatusRef.current = "unavailable";
      premiumUnavailableSinceRef.current = Date.now();
      return "unavailable";
    },
    [],
  );

  // Stop any in-flight premium audio. Used by cancelTts and as a
  // cheap direct call when we know there's no queue to drain.
  const stopPremiumAudio = useCallback(() => {
    const h = activeStreamRef.current;
    if (h) {
      try {
        h.stop();
      } catch {
        /* ignore */
      }
    }
    activeStreamRef.current = null;
  }, []);

  const finishPremiumAudio = useCallback(async () => {
    const h = activeStreamRef.current;
    if (!h) return "played" as const;
    const reason = await h.finish();
    if (activeStreamRef.current === h) {
      activeStreamRef.current = null;
    }
    if (reason === "played") return "played" as const;
    if (reason === "stopped") return "aborted" as const;
    premiumStatusRef.current = "unavailable";
    premiumUnavailableSinceRef.current = Date.now();
    return "unavailable" as const;
  }, []);

  // Append ONE chunk to the premium stream. Non-final premium chunks
  // resolve as soon as their bytes are appended so later chunks can
  // pre-buffer before playback reaches the boundary. The final chunk
  // (or final sentinel) waits for natural playback end. Browser TTS
  // fallback remains sequential.
  const playOneChunk = useCallback(
    async (text: string, final: boolean, onStart: () => void): Promise<void> => {
      if (!text.trim() && final) {
        await finishPremiumAudio();
        return;
      }
      if (!text.trim()) return;
      const speakable = toSpeakable(text);
      if (!speakable.trim()) {
        if (final) await finishPremiumAudio();
        return;
      }
      const emotion = inferVoiceEmotion(speakable);
      const prosody = browserProsodyForEmotion(emotion);
      setCurrentEmotion(emotion);

      const premium = await appendPremiumTts(speakable, emotion, onStart);
      if (premium === "appended") {
        if (final) await finishPremiumAudio();
        return;
      }
      if (premium === "aborted") return;
      stopPremiumAudio();

      if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window)
      ) {
        return;
      }
      setCurrentEmotion(inferVoiceEmotion(speakable));
      await new Promise<void>((resolve) => {
        const synth = window.speechSynthesis;
        let done = false;
        let startFired = false;
        let startTimer: number | null = null;
        let doneTimer: number | null = null;

        const clearTimers = () => {
          if (startTimer) window.clearTimeout(startTimer);
          if (doneTimer) window.clearTimeout(doneTimer);
          startTimer = null;
          doneTimer = null;
        };

        const finish = () => {
          if (done) return;
          done = true;
          clearTimers();
          activeUtteranceRef.current = null;
          resolve();
        };

        const markStarted = () => {
          if (startFired) return;
          startFired = true;
          onStart();
        };

        const speak = (retry: boolean) => {
          const u = new SpeechSynthesisUtterance(speakable);
          activeUtteranceRef.current = u;
          if (voiceRef.current) u.voice = voiceRef.current;
          u.rate = prosody.rate;
          u.pitch = prosody.pitch;
          u.volume = 1.0;
          u.onstart = markStarted;
          u.onend = finish;
          u.onerror = (event) => {
            console.warn("[voice] browser TTS failed:", event.error);
            finish();
          };

          try {
            synth.cancel();
            synth.resume?.();
          } catch {
            /* ignore */
          }

          try {
            synth.speak(u);
          } catch (err) {
            console.warn("[voice] browser TTS speak() failed:", err);
            finish();
            return;
          }

          startTimer = window.setTimeout(() => {
            if (done || startFired) return;
            try {
              synth.resume?.();
            } catch {
              /* ignore */
            }
            if (retry) {
              clearTimers();
              try {
                synth.cancel();
              } catch {
                /* ignore */
              }
              speak(false);
              return;
            }
            // Some browsers do not reliably fire onstart, but still
            // speak. Move the UI/state forward and let onend or the
            // done watchdog finish the queue.
            markStarted();
          }, BROWSER_TTS_START_TIMEOUT_MS);

          const ms = Math.max(
            BROWSER_TTS_DONE_TIMEOUT_MS,
            Math.min(120_000, speakable.length * 90),
          );
          doneTimer = window.setTimeout(() => {
            console.warn("[voice] browser TTS timed out; clearing queue");
            try {
              synth.cancel();
            } catch {
              /* ignore */
            }
            finish();
          }, ms);
        };

        speak(true);
      });
    },
    [appendPremiumTts, finishPremiumAudio, stopPremiumAudio],
  );

  // Drain the queue one chunk at a time. Each chunk carries its
  // own onEnd; it fires only if the queue happens to be empty
  // when that chunk finishes (i.e. this chunk was the last one
  // to play). That way, if the tail-flush enqueues after the
  // chunk-effect, only the tail's onEnd runs — which is the one
  // that correctly handles the final state transition.
  //
  // ttsWorkerRunningRef guards against concurrent workers
  // (serialization). Turn-id guard lets cancelTts abort mid-drain.
  const runTtsWorker = useCallback(async () => {
    if (ttsWorkerRunningRef.current) return;
    ttsWorkerRunningRef.current = true;
    const myTurn = ttsTurnIdRef.current;
    try {
      while (
        ttsQueueRef.current.length > 0 &&
        myTurn === ttsTurnIdRef.current
      ) {
        const next = ttsQueueRef.current.shift();
        if (!next) continue;

        // Guard against a race where cancelTts fired between shift
        // and play — the queue bumped the turn id but we already
        // pulled the entry. Check once more before spawning audio.
        if (myTurn !== ttsTurnIdRef.current) break;

        beginTtsMicGate();
        await playOneChunk(next.text, Boolean(next.final), () => {
          // Guard the speaking state-set against a turn that was
          // cancelled mid-fetch. Without this, a cancelled chunk
          // whose fetch finally returned would flip state back to
          // "speaking" and the user would see a frozen pill.
          if (myTurn === ttsTurnIdRef.current) setState("speaking");
        });

        // Fire this chunk's onEnd only if it was the last one in
        // the queue at the moment it finished. If more were added
        // while it was playing, those chunks' own onEnds will fire
        // when they become the last — so the "final" callback
        // always matches the actually-final chunk.
        if (
          ttsQueueRef.current.length === 0 &&
          myTurn === ttsTurnIdRef.current
        ) {
          try {
            next.onEnd?.();
          } catch (err) {
            console.warn("[voice] onEnd threw:", err);
          }
        }
      }
    } finally {
      ttsWorkerRunningRef.current = false;
    }
  }, [beginTtsMicGate, playOneChunk]);

  const enqueueTts = useCallback(
    (text: string, onEnd?: () => void, final = false) => {
      if (!text.trim() && !final) return;
      ttsQueueRef.current.push({ text, onEnd, final });
      void runTtsWorker();
    },
    [runTtsWorker],
  );

  // Kill everything in flight: empty the queue, stop active stream,
  // cancel browser speechSynthesis, and bump turn id so any worker
  // mid-loop exits before grabbing another chunk. Called on mute,
  // turn-reset (new user utterance), and master-toggle-off.
  const cancelTts = useCallback(() => {
    ttsTurnIdRef.current += 1;
    ttsQueueRef.current.length = 0;
    clearTtsTailGuard();
    setVoiceMachinePhase("LISTENING");
    try {
      ttsAbortControllerRef.current?.abort();
    } catch {
      /* ignore */
    }
    ttsAbortControllerRef.current = null;
    stopPremiumAudio();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
    activeUtteranceRef.current = null;
  }, [clearTtsTailGuard, setVoiceMachinePhase, stopPremiumAudio]);

  // ─── STT lifecycle ───────────────────────────────────────────
  //
  // We run Web Speech in CONTINUOUS mode with interim results and
  // roll our own end-of-turn detection via a silence timer.
  // Chrome's continuous=false mode fires isFinal after ~700 ms of
  // silence, which splits natural pauses mid-sentence into two
  // user turns. Continuous mode lets us accumulate final segments
  // and only dispatch when the user has actually stopped talking.
  //
  // Silence thresholds are two-tier:
  //
  //   Long window (~4500 ms)     → "normal" end-of-turn. Long
  //       enough that a user thinking mid-sentence doesn't get cut
  //       off ("Find me a flight from SFO … to Austin next Friday
  //       … for under $400"). Feels slightly laggy to fast
  //       speakers but is the right default for conversational
  //       and hands-free use.
  //
  //   Short window (~2200 ms)    → only applies once the buffered
  //       transcript is long enough to clearly be a complete
  //       utterance. Tight sentences ("new thread", "yes",
  //       "confirm") dispatch faster; long ones wait.
  //
  // Empty-buffer fires are suppressed entirely — if no final
  // segment has landed yet, the timer is almost certainly
  // triggered by ambient noise or a mic test and we shouldn't
  // dispatch an empty turn.
  // Silence windows live in lib/voice-chunking.ts so they're unit-
  // testable. See DEFAULT_SILENCE for the current tuning.
  const clearRecorderStopTimer = useCallback(() => {
    if (recorderStopTimerRef.current) {
      clearTimeout(recorderStopTimerRef.current);
      recorderStopTimerRef.current = null;
    }
  }, []);

  const stopRecorderStream = useCallback(() => {
    const stream = recorderStreamRef.current;
    recorderStreamRef.current = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const transcribeRecordedAudio = useCallback(
    async (blob: Blob) => {
      if (!blob.size) {
        setInterim("");
        setState("idle");
        return;
      }
      setState("thinking");
      setInterim("Transcribing your voice…");
      const form = new FormData();
      form.set(
        "audio",
        blob,
        `lumo-voice.${blob.type.includes("mp4") ? "m4a" : "webm"}`,
      );
      const language =
        typeof navigator !== "undefined" && /^en(-|$)/i.test(navigator.language)
          ? navigator.language
          : "en-US";
      form.set("language", language);
      try {
        const res = await fetch("/api/stt", {
          method: "POST",
          body: form,
        });
        const data = (await res.json().catch(() => null)) as {
          transcript?: unknown;
          error?: unknown;
        } | null;
        if (!res.ok) {
          const code = typeof data?.error === "string" ? data.error : `stt_${res.status}`;
          throw new Error(code);
        }
        const transcript =
          typeof data?.transcript === "string" ? data.transcript.trim() : "";
        setInterim("");
        if (transcript) {
          setErrorMessage(null);
          userStoppedListeningRef.current = false;
          onUserUtterance(transcript);
          return;
        }
        setErrorMessage("I didn't catch enough audio to transcribe");
        setState("idle");
      } catch (err) {
        console.warn("[voice] recorded STT failed:", err);
        setInterim("");
        setErrorMessage(
          err instanceof Error && err.message === "stt_not_configured"
            ? "recorded speech fallback is not configured"
            : "recorded speech transcription failed",
        );
        setState("error");
      }
    },
    [onUserUtterance],
  );

  const startRecordedFallback = useCallback(
    async (reason?: string) => {
      if (!canRecordFallback()) {
        setErrorMessage("speech input is unavailable in this browser session");
        setState("error");
        return;
      }
      if (recorderRef.current) return;
      cancelTts();
      clearSilenceTimer();
      clearRecorderStopTimer();
      recorderChunksRef.current = [];
      recorderSubmitRef.current = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        const mimeType = preferredRecordingMimeType();
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        recorderStreamRef.current = stream;
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data?.size) recorderChunksRef.current.push(event.data);
        };
        recorder.onerror = (event) => {
          console.warn("[voice] MediaRecorder error:", event);
          clearRecorderStopTimer();
          recorderSubmitRef.current = false;
          recorderRef.current = null;
          stopRecorderStream();
          setInterim("");
          setErrorMessage("microphone recording failed");
          setState("error");
        };
        recorder.onstop = () => {
          clearRecorderStopTimer();
          recorderRef.current = null;
          stopRecorderStream();
          const chunks = recorderChunksRef.current;
          recorderChunksRef.current = [];
          if (!recorderSubmitRef.current) {
            recorderSubmitRef.current = true;
            setInterim("");
            if (!ttsMicPausedRef.current) setState("idle");
            return;
          }
          const blob = new Blob(chunks, {
            type: recorder.mimeType || mimeType || "audio/webm",
          });
          void transcribeRecordedAudio(blob);
        };
        recorder.start();
        if (reason) console.info("[voice] using recorded STT fallback:", reason);
        setErrorMessage(null);
        setInterim("Recording through Lumo STT…");
        setState("listening");
        recorderStopTimerRef.current = setTimeout(() => {
          if (recorderRef.current?.state === "recording") {
            try {
              recorderRef.current.stop();
            } catch {
              /* ignore */
            }
          }
        }, RECORDED_STT_MAX_MS);
      } catch (err) {
        recorderRef.current = null;
        stopRecorderStream();
        recorderChunksRef.current = [];
        recorderSubmitRef.current = true;
        const message =
          err instanceof DOMException
            ? friendlySpeechError(err.name)
            : "microphone recording could not start";
        setErrorMessage(message);
        setState("error");
      }
    },
    [
      cancelTts,
      clearRecorderStopTimer,
      clearSilenceTimer,
      stopRecorderStream,
      transcribeRecordedAudio,
    ],
  );

  const stopRecordedFallback = useCallback(
    (submit: boolean) => {
      clearRecorderStopTimer();
      recorderSubmitRef.current = submit;
      const recorder = recorderRef.current;
      if (!recorder) {
        stopRecorderStream();
        return;
      }
      try {
        if (recorder.state === "recording") {
          recorder.requestData?.();
          recorder.stop();
        }
      } catch {
        recorderRef.current = null;
        stopRecorderStream();
      }
    },
    [clearRecorderStopTimer, stopRecorderStream],
  );

  const startListening = useCallback(() => {
    if (typeof window === "undefined") return;
    const Ctor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
    const supported =
      "speechSynthesis" in window && (Boolean(Ctor) || canRecordFallback());
    supportedRef.current = supported;
    if (!supported) {
      setState("unsupported");
      return;
    }
    if (ttsMicPausedRef.current) return;
    if (!Ctor) {
      void startRecordedFallback("browser speech recognition is unavailable");
      return;
    }

    // Idempotency guard. The hands-free loop can race — both the
    // chunk-speak effect AND the tail-flush effect schedule a
    // setTimeout(() => startListening(), 200) when TTS ends. Without
    // this guard, two SpeechRecognition instances end up running
    // simultaneously and each emits the user's utterance → duplicate
    // turns ("from Chicago" appearing twice in the thread).
    if (recognitionRef.current || recorderRef.current) {
      return;
    }

    userStoppedListeningRef.current = false;
    // Re-arm TTS for the next assistant turn — user explicitly
    // tapped to talk, so they want the response to be audible.
    userStoppedTtsRef.current = false;

    // Stop any current TTS first — user wants to speak now. This
    // also empties the queue and bumps the turn id so any in-flight
    // worker exits before grabbing another chunk.
    cancelTts();

    // Fresh buffer for this listening session.
    finalBufferRef.current = "";
    clearSilenceTimer();

    const rec: SpeechRecognitionLike = new Ctor();
    // Prefer the browser's declared UI language when available; a
    // user who set their laptop to en-GB shouldn't get en-US STT.
    // Defaults to en-US when navigator.language is missing or not
    // an "en-*" tag (we don't guess non-English for now — would
    // need a proper user-preferred_language plumb).
    const navLang =
      typeof navigator !== "undefined" ? navigator.language : "";
    rec.lang = /^en(-|$)/i.test(navLang) ? navLang : "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Dispatch whatever we've accumulated and end the session.
    // Safe to call multiple times — the buffer is cleared before
    // dispatch so the second call is a no-op.
    //
    // IMPORTANT: null recognitionRef immediately. Web Speech's
    // onend is async and can lag several hundred ms after stop();
    // the hands-free loop's next startListening() fires before
    // then and was bailing out on the "recognizer already alive"
    // idempotency guard, which is why the mic "stopped working"
    // after the first turn.
    const dispatchAndStop = () => {
      clearSilenceTimer();
      const finalText = finalBufferRef.current.trim();
      finalBufferRef.current = "";
      setInterim("");
      if (finalText) {
        userStoppedListeningRef.current = false;
        onUserUtterance(finalText);
      }
      if (recognitionRef.current === rec) {
        recognitionRef.current = null;
      }
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    };

    // Pick the right silence window based on how much the user has
    // said so far. Delegates to lib/voice-chunking.ts so the tuning
    // is testable. Never fires with an empty buffer — that's almost
    // always ambient noise, and we re-arm on the long window.
    const scheduleSilenceFire = () => {
      clearSilenceTimer();
      silenceTimerRef.current = setTimeout(() => {
        silenceTimerRef.current = null;
        const decision = silenceDecision(finalBufferRef.current);
        if (decision === "rearm") {
          silenceTimerRef.current = setTimeout(
            () => dispatchAndStop(),
            DEFAULT_SILENCE.longMs,
          );
          return;
        }
        dispatchAndStop();
      }, chooseSilenceWindowPure(finalBufferRef.current));
    };

    rec.onstart = () => {
      autoListenUnlockedRef.current = true;
      userStoppedListeningRef.current = false;
      setErrorMessage(null);
      setState("listening");
      setInterim("");
    };
    rec.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        const alt = r[0];
        if (!alt) continue;
        if (r.isFinal) {
          // Accumulate into the turn buffer — do NOT dispatch yet.
          // Web Speech fires a fresh final on every short pause;
          // we want the full sentence, joined with spaces.
          const seg = alt.transcript.trim();
          if (seg) {
            finalBufferRef.current = finalBufferRef.current
              ? `${finalBufferRef.current} ${seg}`
              : seg;
          }
        } else {
          interimText += alt.transcript;
        }
      }

      // Show current-state transcript in the "Heard:" pill —
      // combination of committed finals + what the user is still
      // saying. Reads more naturally than just the latest interim.
      const committed = finalBufferRef.current;
      setInterim(
        committed && interimText
          ? `${committed} ${interimText}`
          : committed || interimText,
      );

      // Reset the silence timer. End-of-turn fires only after an
      // idle window appropriate to how much the user has said.
      scheduleSilenceFire();
    };
    rec.onerror = (e) => {
      const code = e.error ?? "unknown";
      clearSilenceTimer();
      if (code === "no-speech" || code === "aborted") {
        // Benign. If we have buffered text, dispatch it; otherwise
        // just drop back to idle.
        const buffered = finalBufferRef.current.trim();
        finalBufferRef.current = "";
        setInterim("");
        if (recognitionRef.current === rec) {
          recognitionRef.current = null;
        }
        if (ttsMicPausedRef.current) return;
        if (buffered) onUserUtterance(buffered);
        setState("idle");
        return;
      }
      if (code === "network") {
        // Chrome/Safari Web Speech can fail when the browser's remote
        // speech service is unreachable. Treat it as voice-input
        // unavailable for this attempt, not as a fatal app error.
        const buffered = finalBufferRef.current.trim();
        finalBufferRef.current = "";
        setInterim("");
        if (recognitionRef.current === rec) {
          recognitionRef.current = null;
        }
        if (buffered) {
          try {
            onUserUtterance(buffered);
          } catch {
            /* ignore */
          }
        }
        void startRecordedFallback(
          "browser speech service is unreachable",
        );
        return;
      }
      const buffered = finalBufferRef.current.trim();
      finalBufferRef.current = "";
      setInterim("");
      if (recognitionRef.current === rec) {
        recognitionRef.current = null;
      }
      if (buffered) {
        try {
          onUserUtterance(buffered);
        } catch {
          /* ignore */
        }
      }
      setErrorMessage(friendlySpeechError(code));
      setState("error");
    };
    rec.onend = () => {
      clearSilenceTimer();
      // If the recognizer ended with anything still buffered —
      // browser sometimes ends the session unprompted, e.g. tab
      // visibility change — flush it so we don't lose the turn.
      const pending = finalBufferRef.current.trim();
      finalBufferRef.current = "";
      if (pending) {
        try {
          onUserUtterance(pending);
        } catch {
          /* ignore */
        }
      }
      if (recognitionRef.current === rec) {
        recognitionRef.current = null;
      }
      setState((prev) => (prev === "listening" ? "idle" : prev));
      if (
        !pending &&
        canResumeListeningAfterTts({
          autoListenUnlocked: true,
          handsFree: wantHandsFreeRef.current,
          userStoppedListening: userStoppedListeningRef.current,
          enabled: enabledRef.current,
          busy: busyRef.current,
          micPausedForTts: ttsMicPausedRef.current,
        })
      ) {
        window.setTimeout(() => {
          if (ttsMicPausedRef.current) return;
          if (
            canResumeListeningAfterTts({
              autoListenUnlocked: true,
              handsFree: wantHandsFreeRef.current,
              userStoppedListening: userStoppedListeningRef.current,
              enabled: enabledRef.current,
              busy: busyRef.current,
              micPausedForTts: ttsMicPausedRef.current,
            })
          ) {
            startListening();
          }
        }, 250);
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      recognitionRef.current = null;
      clearSilenceTimer();
      finalBufferRef.current = "";
      setInterim("");
      const message =
        err instanceof DOMException
          ? friendlySpeechError(err.name)
          : err instanceof Error
            ? friendlySpeechError(err.message)
            : "Voice could not start. Tap to try again.";
      setErrorMessage(message);
      setState("error");
      console.warn("[voice] start failed:", err);
    }
  }, [onUserUtterance, cancelTts, clearSilenceTimer, startRecordedFallback]);

  const scheduleHandsFreeListening = useCallback(
    (delayMs = 200) => {
      if (
        !canResumeListeningAfterTts({
          autoListenUnlocked: autoListenUnlockedRef.current,
          handsFree: wantHandsFreeRef.current,
          userStoppedListening: userStoppedListeningRef.current,
          enabled: enabledRef.current,
          busy: busyRef.current,
          micPausedForTts: ttsMicPausedRef.current,
        })
      ) {
        return;
      }
      window.setTimeout(() => {
        if (
          !canResumeListeningAfterTts({
            autoListenUnlocked: autoListenUnlockedRef.current,
            handsFree: wantHandsFreeRef.current,
            userStoppedListening: userStoppedListeningRef.current,
            enabled: enabledRef.current,
            busy: busyRef.current,
            micPausedForTts: ttsMicPausedRef.current,
          })
        ) {
          return;
        }
        startListening();
      }, delayMs);
    },
    [startListening],
  );

  const completeTtsWithTailGuard = useCallback(() => {
    clearTtsTailGuard();
    setVoiceMachinePhase("POST_SPEAKING_GUARD");
    setState("post_speaking_guard");
    ttsTailGuardTimerRef.current = setTimeout(() => {
      ttsTailGuardTimerRef.current = null;
      setVoiceMachinePhase("LISTENING");
      setState("idle");
      scheduleHandsFreeListening(0);
    }, TTS_TAIL_GUARD_MS);
  }, [clearTtsTailGuard, scheduleHandsFreeListening, setVoiceMachinePhase]);

  // User-initiated Stop while Lumo is speaking. Halts TTS and goes
  // straight to idle — does NOT auto-restart listening even when
  // hands-free is on. The button labeled "Stop" must mean stop.
  //
  // userStoppedListeningRef = true blocks the rec.onend /
  // scheduleHandsFreeListening auto-resume.
  // userStoppedTtsRef    = true blocks the spokenText-driven TTS
  // feeder from re-enqueuing audio for the rest of this assistant
  // turn (the LLM keeps streaming text after the user clicks Stop;
  // without this gate, new chunks land in the queue ~100ms later
  // and audio resumes — which is what made the button look broken).
  // Both flags reset on the next user-initiated tap-to-talk, and
  // userStoppedTtsRef also resets when a new agent turn starts.
  const stopSpeakingAndReturnToListening = useCallback(() => {
    cancelTts();
    clearTtsTailGuard();
    setVoiceMachinePhase("LISTENING");
    setState("idle");
    userStoppedListeningRef.current = true;
    userStoppedTtsRef.current = true;
    // Move spoken-so-far cursor to the end of whatever has been
    // streamed so the tail-flush effect can't re-feed the gap.
    spokenSoFarRef.current = spokenText.length;
  }, [cancelTts, clearTtsTailGuard, setVoiceMachinePhase, spokenText]);

  const stopListening = useCallback(() => {
    if (recorderRef.current) {
      stopRecordedFallback(true);
      return;
    }
    const rec = recognitionRef.current;
    if (!rec) return;
    userStoppedListeningRef.current = true;
    // Flush anything we've heard so far — otherwise the user's
    // mid-sentence Stop click loses the transcript silently.
    clearSilenceTimer();
    const buffered = finalBufferRef.current.trim();
    finalBufferRef.current = "";
    setInterim("");
    // Null the ref immediately for the same reason as
    // dispatchAndStop — onend lag was blocking the next
    // startListening().
    recognitionRef.current = null;
    if (buffered) {
      try {
        onUserUtterance(buffered);
      } catch {
        /* ignore */
      }
    }
    try {
      rec.stop();
    } catch {
      // ignore
    }
    setState("idle");
  }, [clearSilenceTimer, onUserUtterance, stopRecordedFallback]);

  // Muting mid-speech should kill in-flight audio immediately,
  // drain the queue so nothing resumes on un-mute, and bump the
  // turn id so any worker mid-loop exits instead of grabbing the
  // next chunk.
  useEffect(() => {
    if (!muted) return;
    cancelTts();
  }, [muted, cancelTts]);

  // ─── TTS: speak the next sentence as assistant text grows ────
  //
  // We NEVER call play directly from this effect. Every speakable
  // chunk is pushed onto ttsQueueRef and the worker drains them
  // serially. The fix for the "multiple voices" bug lives entirely
  // in that serialization — if two chunks become ready before the
  // first finishes playing, they wait their turn instead of
  // starting a second parallel <Audio>.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;

    // Agent turn just started (spokenText reset to something
    // shorter than what we'd seen). Clear speak-index AND cancel
    // any leftover audio/queue from the previous turn — otherwise
    // the tail of turn N-1 plays over the head of turn N. Also
    // re-arm TTS for this fresh turn (clears the user-stopped gate
    // from a previous Stop click).
    if (spokenText.length < lastSpokenTextRef.current.length) {
      spokenSoFarRef.current = 0;
      userStoppedTtsRef.current = false;
      cancelTts();
    }
    lastSpokenTextRef.current = spokenText;

    // User clicked Stop on this turn. Don't push the still-arriving
    // tokens into the TTS queue; the chat bubble stays so the user
    // can read what Lumo wanted to say.
    if (userStoppedTtsRef.current) return;

    const untouched = spokenText.slice(spokenSoFarRef.current);
    const { chunks, rest } = nextSpeakableChunks(untouched);
    if (chunks.length === 0) return;

    // Commit these chunks as spoken — even when muted, so we don't
    // reread them once the user un-mutes mid-response.
    spokenSoFarRef.current = spokenText.length - rest.length;

    // Muted: suppress TTS but keep the hands-free loop. When the
    // response ends, we'll still auto-restart listening via the
    // tail-flush effect below.
    if (muted) return;

    // Enqueue sentence-bounded chunks as non-final appends. The
    // tail-flush effect below is the only place that marks the
    // stream final and lets MediaSource end. That prevents the
    // first sentence's audio element from ending before sentence 2
    // has a chance to append.
    chunks.forEach((chunk) => enqueueTts(chunk));
  }, [
    spokenText,
    enabled,
    muted,
    enqueueTts,
    cancelTts,
  ]);

  // Flush the tail once the agent turn ends (!busy) so we don't
  // drop the last sentence if it didn't end with punctuation. Also
  // enqueued — the worker will pick it up after any chunks still
  // in flight, which prevents the race where the tail flush used
  // to start its own concurrent fetch.
  useEffect(() => {
    if (busy) return;
    if (!enabled || typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;
    // User stopped this turn explicitly — don't tail-flush either,
    // and skip the hands-free auto-resume so Stop fully sticks.
    if (userStoppedTtsRef.current) return;

    const tail = spokenText.slice(spokenSoFarRef.current).trim();
    const tailChunks = finalSpeakableChunks(tail);
    if (tailChunks.length === 0) {
      // Nothing new to append, but an earlier sentence may still be
      // playing from the open chunked MediaSource. Push a final
      // sentinel through the same queue so endOfStream happens only
      // after all previous appends drain.
      enqueueTts(
        "",
        completeTtsWithTailGuard,
        true,
      );
      return;
    }

    spokenSoFarRef.current = spokenText.length;

    if (muted) {
      if (wantHandsFreeRef.current && enabled) {
        setState("idle");
        scheduleHandsFreeListening();
      } else {
        setState("idle");
      }
      return;
    }

    tailChunks.forEach((chunk, index) =>
      enqueueTts(
        chunk,
        index === tailChunks.length - 1
          ? completeTtsWithTailGuard
          : undefined,
        index === tailChunks.length - 1,
      ),
    );
  }, [
    busy,
    spokenText,
    enabled,
    muted,
    enqueueTts,
    completeTtsWithTailGuard,
    scheduleHandsFreeListening,
  ]);

  // Belt-and-suspenders safety net: if we're idle by intent (no
  // queue, no worker, no recognizer, not busy) but state is stuck
  // at "speaking" or "thinking" from some dropped transition, force
  // idle. This catches the edge cases where cancelTts fired
  // mid-drain and ate the final onEnd that would have transitioned
  // us. Cheap — just a couple of ref reads — and prevents the
  // "Skip keeps showing" symptom the user reported.
  useEffect(() => {
    if (!enabled) return;
    if (busy) return;
    if (state !== "speaking" && state !== "thinking") return;
    const noQueue = ttsQueueRef.current.length === 0;
    const noWorker = !ttsWorkerRunningRef.current;
    const noPremiumAudio = activeStreamRef.current === null;
    const noRec = recognitionRef.current === null;
    const noRecorded = recorderRef.current === null;
    if (noQueue && noWorker && noPremiumAudio && noRec && noRecorded) {
      clearTtsTailGuard();
      setVoiceMachinePhase("LISTENING");
      setState("idle");
      if (wantHandsFreeRef.current) {
        scheduleHandsFreeListening();
      }
    }
  }, [
    busy,
    state,
    enabled,
    clearTtsTailGuard,
    scheduleHandsFreeListening,
    setVoiceMachinePhase,
    spokenText,
  ]);

  // While the network is busy, reflect "thinking" if we're not mid-TTS.
  useEffect(() => {
    if (!enabled) return;
    if (
      busy &&
      typeof window !== "undefined" &&
      !activeStreamRef.current &&
      !window.speechSynthesis?.speaking
    ) {
      setState("thinking");
    }
  }, [busy, enabled]);

  // ─── J5 — barge-in lifecycle ─────────────────────────────────
  // Legacy barge-in scaffold. Voice-mode STT is explicitly muted while TTS
  // is active, so this monitor must stay off under the TTS mic gate; manual
  // Stop still cancels TTS and hands control back to the user.
  useEffect(() => {
    if (!BARGE_IN_ENABLED) return;
    if (!enabled) return;
    if (state !== "speaking") return;
    if (ttsMicPausedRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const h = await startBargeInMonitor({
          onBargeIn: () => {
            // User started speaking over Lumo — stop TTS immediately
            // and hand off to the normal listening path.
            if (typeof window !== "undefined") {
              try {
                window.speechSynthesis?.cancel();
              } catch {
                // ignore
              }
            }
            stopPremiumAudio();
            userStoppedListeningRef.current = false;
            startListening();
          },
        });
        if (cancelled) {
          h.stop();
          return;
        }
        bargeInRef.current = h;
      } catch (err) {
        // Mic permission denied or browser too old — silent fallback.
        // The existing "tap mic to talk" UX still works; barge-in just
        // won't interrupt. No user-visible error.
        console.info(
          "[voice] barge-in unavailable:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
    return () => {
      cancelled = true;
      const h = bargeInRef.current;
      bargeInRef.current = null;
      try {
        h?.stop();
      } catch {
        // ignore
      }
    };
  }, [enabled, state, startListening, stopPremiumAudio]);

  // ─── J5 — wake word lifecycle ───────────────────────────────
  // When voice is enabled AND we're idle, listen for "Hey Lumo" (or
  // the default "computer" keyword) and auto-start listening on
  // detection. No-op unless NEXT_PUBLIC_PORCUPINE_ACCESS_KEY is set
  // AND @picovoice/porcupine-web is installed — see lib/wake-word.ts.
  useEffect(() => {
    if (!enabled) return;
    if (state !== "idle") return;
    let cancelled = false;
    void (async () => {
      try {
        const h = await startWakeWord({
          onWake: () => {
            // Wake word fired — jump to listening. Clear any interim
            // from a previous aborted attempt.
            setInterim("");
            userStoppedListeningRef.current = false;
            startListening();
          },
        });
        if (cancelled) {
          h.stop();
          return;
        }
        wakeWordRef.current = h;
      } catch {
        // ignore — scaffold swallows its own errors
      }
    })();
    return () => {
      cancelled = true;
      const h = wakeWordRef.current;
      wakeWordRef.current = null;
      try {
        h?.stop();
      } catch {
        // ignore
      }
    };
  }, [enabled, state, startListening]);

  // Master toggle — clean shutdown when leaving voice mode.
  useEffect(() => {
    if (!enabled) {
      try {
        recognitionRef.current?.abort();
      } catch {
        // ignore
      }
      stopRecordedFallback(false);
      try {
        bargeInRef.current?.stop();
      } catch {
        // ignore
      }
      bargeInRef.current = null;
      try {
        wakeWordRef.current?.stop();
      } catch {
        // ignore
      }
      wakeWordRef.current = null;
      cancelTts();
      setState("off");
      setInterim("");
      return;
    }
    if (state === "off" && supportedRef.current) setState("idle");
    if (state === "off" && !supportedRef.current) setState("unsupported");
  }, [enabled, state, cancelTts, stopRecordedFallback]);

  // ─── Presentation ────────────────────────────────────────────
  if (state === "unsupported" && enabled) {
    return (
      <div className="rounded-xl border border-lumo-border bg-lumo-bg-subtle px-3 py-2 text-[12px] text-lumo-fg-low">
        Voice isn&apos;t supported in this browser. Try Chrome or Safari on
        a device with a microphone, or keep going in text mode.
        <button
          className="ml-2 underline"
          onClick={() => onToggle(false)}
        >
          switch to text
        </button>
      </div>
    );
  }

  // When voice is off: nothing renders here. The mic button in the
  // composer toolbar is the single affordance to turn voice on.
  // (Used to render a "Voice off" pill — removed in the cleanup
  // since it duplicated the composer button.)
  if (!enabled) return null;

  const primaryAction = primaryActionForVoiceState(state);
  const handlePrimaryAction = () => {
    switch (primaryAction.kind) {
      case "tap_to_talk":
        startListening();
        break;
      case "stop_listening":
        stopListening();
        break;
      case "stop_speaking":
        stopSpeakingAndReturnToListening();
        break;
      case "cancel":
      case "disabled":
        break;
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Mic — the master on/off */}
        <button
          type="button"
          aria-pressed={enabled}
          aria-label="Turn voice off"
          onClick={() => onToggle(false)}
          className="inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-medium transition bg-lumo-accent text-lumo-accent-ink shadow-[0_0_16px_rgba(94,234,172,0.35)]"
        >
          <MicIcon active />
          Voice on
        </button>

        {/* Speaker — mute / unmute TTS */}
        <button
          type="button"
          aria-pressed={muted}
          aria-label={muted ? "Unmute Lumo's voice" : "Mute Lumo's voice"}
          onClick={() => onMutedToggle(!muted)}
          title={
            muted
              ? "Lumo is muted — click to hear responses"
              : "Mute Lumo's voice (mic stays on)"
          }
          className={
            "inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] transition " +
            (muted
              ? "border border-lumo-hair text-lumo-fg-low hover:text-lumo-fg"
              : "border border-lumo-accent/50 text-lumo-accent hover:bg-lumo-accent/10")
          }
        >
          <SpeakerIcon muted={muted} />
          {muted ? "Muted" : "Speaker"}
        </button>

        {/* Hands-free — when on, Lumo auto-resumes listening after
            speaking. When off, every turn is a tap-to-talk. The
            toggle was previously hidden which left the system stuck
            on continuous mode with no way to opt out. */}
        <button
          type="button"
          aria-pressed={handsFree}
          aria-label={
            handsFree ? "Turn off continuous mode" : "Turn on continuous mode"
          }
          onClick={() => onHandsFreeToggle(!handsFree)}
          title={
            handsFree
              ? "Continuous mode on — Lumo auto-listens after speaking"
              : "Continuous mode off — tap to talk for every turn"
          }
          className={
            "inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] transition " +
            (handsFree
              ? "border border-lumo-accent/50 text-lumo-accent hover:bg-lumo-accent/10"
              : "border border-lumo-hair text-lumo-fg-low hover:text-lumo-fg")
          }
        >
          {handsFree ? "Continuous" : "Tap each"}
        </button>

        {/* Status pill */}
        <span
          className={
            "inline-flex items-center gap-1.5 text-[11.5px] uppercase tracking-[0.14em] font-medium " +
            stateToneClass(state)
          }
          aria-live="polite"
        >
          <StatusDot state={state} />
          {stateLabel(state, currentEmotion)}
        </span>

        {state === "speaking" ? (
          <span className="rounded-full border border-lumo-hair px-2 py-1 text-[11px] text-lumo-fg-low">
            {emotionLabel(currentEmotion)}
          </span>
        ) : null}

        {/* Primary action — always present while voice mode is on. */}
        <button
          type="button"
          onClick={handlePrimaryAction}
          disabled={primaryAction.disabled}
          className={
            "ml-auto rounded-full border border-lumo-hair px-4 py-2 text-[13px] transition-colors " +
            (primaryAction.disabled
              ? "text-lumo-fg-low opacity-60"
              : "text-lumo-fg hover:bg-lumo-elevated")
          }
        >
          {primaryAction.label}
        </button>
      </div>

      {interim ? (
        <div className="rounded-xl border border-lumo-hair bg-lumo-elevated/50 px-3 py-2 text-[13.5px]">
          <span className="text-lumo-fg-low">Heard: </span>
          <span className="text-lumo-fg">{interim}</span>
        </div>
      ) : null}

      {state === "idle" && errorMessage ? (
        <div className="rounded-xl border border-lumo-warn/35 bg-lumo-warn/5 px-3 py-2 text-[13px] text-lumo-warn">
          Voice note: {errorMessage}. Use text or tap to retry.
        </div>
      ) : null}

      {state === "error" && errorMessage ? (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-3 py-2 text-[13px] text-red-400">
          Voice error: {errorMessage}. Tap the mic to retry.
        </div>
      ) : null}
    </div>
  );
}

function friendlySpeechError(code: string): string {
  const normalized = code.toLowerCase();
  if (
    normalized.includes("not-allowed") ||
    normalized.includes("permission") ||
    normalized.includes("denied")
  ) {
    return "microphone permission is blocked";
  }
  if (normalized.includes("audio-capture") || normalized.includes("notfound")) {
    return "no microphone was found";
  }
  if (normalized.includes("network")) {
    return "speech recognition could not reach the browser speech service";
  }
  if (normalized.includes("invalidstate")) {
    return "speech recognition was already starting";
  }
  return code || "voice could not start";
}

function parseVoiceEmotion(value: string | null): VoiceEmotion | null {
  if (
    value === "neutral" ||
    value === "warm" ||
    value === "reassuring" ||
    value === "excited" ||
    value === "celebratory"
  ) {
    return value;
  }
  return null;
}

function stateLabel(s: VoiceState, emotion: VoiceEmotion): string {
  switch (s) {
    case "off":
      return "off";
    case "idle":
      return "ready";
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return emotionLabel(emotion);
    case "post_speaking_guard":
      return "speaking";
    case "unsupported":
      return "not supported";
    case "error":
      return "error";
  }
}

function emotionLabel(emotion: VoiceEmotion): string {
  switch (emotion) {
    case "celebratory":
      return "celebrating";
    case "excited":
      return "upbeat";
    case "reassuring":
      return "reassuring";
    case "warm":
      return "warm voice";
    case "neutral":
      return "speaking";
  }
}

function stateToneClass(s: VoiceState): string {
  switch (s) {
    case "listening":
      return "text-lumo-accent";
    case "thinking":
      return "text-lumo-fg-low";
    case "speaking":
    case "post_speaking_guard":
      return "text-emerald-400";
    case "error":
      return "text-red-400";
    case "unsupported":
      return "text-lumo-fg-low";
    default:
      return "text-lumo-fg-low";
  }
}

function StatusDot({ state }: { state: VoiceState }) {
  const cls =
    state === "listening"
      ? "bg-lumo-accent animate-pulse"
      : state === "thinking"
      ? "bg-amber-400 animate-pulse"
      : state === "speaking" || state === "post_speaking_guard"
      ? "bg-emerald-400 animate-pulse"
      : state === "error"
      ? "bg-red-400"
      : "bg-lumo-fg-low/40";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} aria-hidden />;
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      {muted ? (
        <>
          <path d="m22 9-6 6" />
          <path d="m16 9 6 6" />
        </>
      ) : (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      )}
    </svg>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={active ? "" : "opacity-80"}
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}
