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
 *   - Browser-native TTS via speechSynthesis. As the agent streams
 *     text frames, the shell accumulates assistant text and passes
 *     it here via `spokenText`. We debounce + chunk into sentence
 *     pushes so we start speaking early instead of waiting for the
 *     full response.
 *
 *   - A clear visual state machine — idle / listening / thinking /
 *     speaking / error — so even a glance at the screen conveys
 *     where we are. The JARVIS affordance.
 *
 *   - Hands-free mode: after TTS finishes speaking, auto-restart
 *     listening. Click-to-talk mode: user taps the mic each turn.
 *
 *   - Graceful degradation: no SpeechRecognition? The component
 *     renders a one-line "not supported — use text" and disables
 *     itself. No throws.
 *
 * NOT in v1:
 *   - Wake word ("Hey Lumo"). Planned for v2 via picovoice.
 *   - Barge-in (user speaking interrupts TTS). v2/v3.
 *   - Premium TTS (ElevenLabs streaming). v2.
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
import { playAudioStream, type StreamingAudioHandle } from "@/lib/streaming-audio";
import { getSelectedVoiceId } from "@/lib/voice-catalog";

// How long to honor a "premium TTS unavailable" verdict before
// re-probing. Tuned for transient upstream issues (ElevenLabs 402
// while billing bumps through, brief 5xx, network glitch) — 60 s is
// long enough to avoid thrash on every chunk, short enough to recover
// within a single conversation once upstream heals.
const PREMIUM_TTS_COOLDOWN_MS = 60_000;

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

/**
 * Chunk a growing text buffer at sentence boundaries so we can
 * start speaking before the full response arrives. Returns the
 * (next-ready-chunk, remaining-tail). A chunk is "ready" if it ends
 * with . ! ? or a newline AND is at least ~20 chars (so we don't
 * speak fragments like "Ok.").
 */
function nextSpeakableChunk(buf: string): { chunk: string; rest: string } {
  if (buf.length < 20) return { chunk: "", rest: buf };
  const re = /([.!?]+\s)|(\n{2,})/g;
  let lastMatch = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    lastMatch = re.lastIndex;
  }
  if (lastMatch < 0) return { chunk: "", rest: buf };
  return { chunk: buf.slice(0, lastMatch).trim(), rest: buf.slice(lastMatch) };
}

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
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  // Premium TTS state — starts "unknown", flips to "available" after
  // first successful /api/tts call, or "unavailable" after a network
  // or non-2xx response. Crucially NOT a session-permanent lock: we
  // hold the "unavailable" verdict for `PREMIUM_TTS_COOLDOWN_MS` then
  // quietly re-probe on the next speech turn. This means a transient
  // upstream blip (ElevenLabs 402/timeout, short outage) no longer
  // condemns the rest of the session to browser TTS — we recover as
  // soon as the upstream does.
  const premiumStatusRef = useRef<"unknown" | "available" | "unavailable">(
    "unknown",
  );
  const premiumUnavailableSinceRef = useRef<number>(0);
  // Active streaming-audio handle for the in-flight premium TTS
  // chunk, if any. Mute / cancel / barge-in call .stop() on it.
  const activeStreamRef = useRef<StreamingAudioHandle | null>(null);
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
  const ttsQueueRef = useRef<string[]>([]);
  const ttsWorkerRunningRef = useRef<boolean>(false);
  const ttsTurnIdRef = useRef<number>(0); // bumped on every fresh turn
  const spokenSoFarRef = useRef<number>(0); // index into spokenText already sent to TTS
  const lastSpokenTextRef = useRef<string>(spokenText);
  const userStoppedListeningRef = useRef<boolean>(false); // user intent to be off
  const wantHandsFreeRef = useRef<boolean>(handsFree);
  useEffect(() => {
    wantHandsFreeRef.current = handsFree;
  }, [handsFree]);

  // J5 — barge-in: a second mic pipeline that stays open while TTS is
  // playing. When it detects user speech, we cancel TTS and pivot to
  // STT. Lives only while state === "speaking" so we don't hold a
  // mic open unnecessarily.
  const bargeInRef = useRef<BargeInHandle | null>(null);
  // J5 — wake word: optional Porcupine scaffold. active=false when no
  // access key is present, so this is a no-op in most environments.
  const wakeWordRef = useRef<WakeWordHandle | null>(null);

  // ─── Capability detection ────────────────────────────────────
  const supportedRef = useRef<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const Ctor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
    supportedRef.current = Boolean(Ctor) && "speechSynthesis" in window;
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

  // ─── Premium TTS (ElevenLabs via /api/tts) ────────────────────
  //
  // Declared BEFORE the STT lifecycle because startListening needs
  // to call cancelTts() to stop any in-flight audio when the user
  // begins speaking. The six functions below (playPremiumTts,
  // stopPremiumAudio, playOneChunk, runTtsWorker, enqueueTts,
  // cancelTts) are all useCallback-stable refs so the dependency
  // arrays downstream don't trigger unnecessary re-renders.
  const playPremiumTts = useCallback(
    async (
      text: string,
      onStart: () => void,
    ): Promise<"played" | "unavailable" | "aborted"> => {
      if (typeof window === "undefined") return "unavailable";

      if (premiumStatusRef.current === "unavailable") {
        const sinceMs = Date.now() - premiumUnavailableSinceRef.current;
        if (sinceMs < PREMIUM_TTS_COOLDOWN_MS) {
          return "unavailable";
        }
        premiumStatusRef.current = "unknown";
      }

      let res: Response;
      try {
        res = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text,
            voice_id: getSelectedVoiceId(),
          }),
        });
      } catch (e) {
        console.warn("[voice] /api/tts network failure, falling back:", e);
        premiumStatusRef.current = "unavailable";
        premiumUnavailableSinceRef.current = Date.now();
        return "unavailable";
      }

      if (!res.ok || !res.body) {
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

      return new Promise<"played" | "aborted">((resolve) => {
        const handle = playAudioStream(res, {
          onStart: () => onStart(),
          onEnd: (reason) => {
            if (activeStreamRef.current === handle) {
              activeStreamRef.current = null;
            }
            resolve(reason === "played" ? "played" : "aborted");
          },
        });
        activeStreamRef.current = handle;
      });
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

  // Play ONE chunk to completion. Tries premium first, falls back
  // to speechSynthesis only on premium failure. Resolves ONLY when
  // the audio has actually finished — runTtsWorker depends on that
  // to serialize. Never call this from a render effect directly;
  // enqueue via enqueueTts().
  const playOneChunk = useCallback(
    async (text: string, onStart: () => void): Promise<void> => {
      if (!text.trim()) return;
      const speakable = toSpeakable(text);

      const premium = await playPremiumTts(speakable, onStart);
      if (premium === "played" || premium === "aborted") return;

      if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window)
      ) {
        return;
      }
      const u = new SpeechSynthesisUtterance(speakable);
      if (voiceRef.current) u.voice = voiceRef.current;
      u.rate = 1.05;
      u.pitch = 1.0;
      u.volume = 1.0;
      await new Promise<void>((resolve) => {
        u.onstart = onStart;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      });
    },
    [playPremiumTts],
  );

  // Drain the queue one chunk at a time. ttsWorkerRunningRef
  // guards against concurrent workers (which would re-introduce
  // the overlap bug). The worker captures the turn id at entry;
  // if cancelTts bumps it mid-drain, the loop exits instead of
  // grabbing the next queued chunk.
  const runTtsWorker = useCallback(
    async (onFinalChunkEnd?: () => void) => {
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
          await playOneChunk(next, () => setState("speaking"));
        }
      } finally {
        ttsWorkerRunningRef.current = false;
      }
      if (
        myTurn === ttsTurnIdRef.current &&
        ttsQueueRef.current.length === 0
      ) {
        onFinalChunkEnd?.();
      }
    },
    [playOneChunk],
  );

  const enqueueTts = useCallback(
    (text: string, onFinalChunkEnd?: () => void) => {
      if (!text.trim()) return;
      ttsQueueRef.current.push(text);
      void runTtsWorker(onFinalChunkEnd);
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
    stopPremiumAudio();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
  }, [stopPremiumAudio]);

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
  //   SILENCE_END_MS (2500 ms)   → "normal" end-of-turn. Long
  //       enough that a user thinking mid-sentence doesn't get cut
  //       off ("Find me a flight from SFO … to Austin next Friday
  //       … for under $400"). Feels slightly laggy to fast
  //       speakers but is the right default for conversational
  //       and hands-free use.
  //
  //   SILENCE_SHORT_MS (1200 ms) → only applies once the buffered
  //       transcript is long enough to clearly be a complete
  //       utterance. Tight sentences ("new thread", "yes",
  //       "confirm") dispatch faster; long ones wait.
  //
  // Empty-buffer fires are suppressed entirely — if no final
  // segment has landed yet, the timer is almost certainly
  // triggered by ambient noise or a mic test and we shouldn't
  // dispatch an empty turn.
  const SILENCE_END_MS = 2500;
  const SILENCE_SHORT_MS = 1200;
  const LONG_UTTERANCE_CHARS = 60; // > ~10 words — treat as "done"
  const finalBufferRef = useRef<string>("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const startListening = useCallback(() => {
    if (!supportedRef.current) return;
    if (typeof window === "undefined") return;
    const Ctor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
    if (!Ctor) return;

    // Idempotency guard. The hands-free loop can race — both the
    // chunk-speak effect AND the tail-flush effect schedule a
    // setTimeout(() => startListening(), 200) when TTS ends. Without
    // this guard, two SpeechRecognition instances end up running
    // simultaneously and each emits the user's utterance → duplicate
    // turns ("from Chicago" appearing twice in the thread).
    if (recognitionRef.current) {
      return;
    }

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
    // dispatch so the second call is a no-op. Also safe to call
    // with an empty buffer (the timer path gates on that, but
    // explicit stop may still hit this path).
    const dispatchAndStop = () => {
      clearSilenceTimer();
      const finalText = finalBufferRef.current.trim();
      finalBufferRef.current = "";
      setInterim("");
      if (finalText) {
        userStoppedListeningRef.current = false;
        onUserUtterance(finalText);
      }
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    };

    // Pick the right silence window based on how much the user has
    // said so far. A long, clearly-complete utterance can dispatch
    // on the shorter window (~1.2 s); a short/partial one waits
    // longer (~2.5 s) so we don't truncate mid-thought. Never fires
    // with an empty buffer — that's almost always ambient noise.
    const scheduleSilenceFire = () => {
      clearSilenceTimer();
      silenceTimerRef.current = setTimeout(() => {
        silenceTimerRef.current = null;
        if (!finalBufferRef.current.trim()) {
          // Nothing buffered yet — re-arm on the long window and
          // wait for the user to actually say something.
          silenceTimerRef.current = setTimeout(
            () => dispatchAndStop(),
            SILENCE_END_MS,
          );
          return;
        }
        dispatchAndStop();
      }, chooseSilenceWindow());
    };

    const chooseSilenceWindow = (): number => {
      const len = finalBufferRef.current.trim().length;
      return len >= LONG_UTTERANCE_CHARS ? SILENCE_SHORT_MS : SILENCE_END_MS;
    };

    rec.onstart = () => {
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
      if (code === "no-speech" || code === "aborted") {
        // Benign. If we have buffered text, dispatch it; otherwise
        // just drop back to idle.
        clearSilenceTimer();
        const buffered = finalBufferRef.current.trim();
        finalBufferRef.current = "";
        if (buffered) onUserUtterance(buffered);
        setState("idle");
        return;
      }
      setErrorMessage(code);
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
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      // Calling start() while recognition is already running throws
      // "InvalidStateError" — treat as a no-op.
      console.warn("[voice] start failed:", err);
    }
  }, [onUserUtterance, cancelTts, clearSilenceTimer]);

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    userStoppedListeningRef.current = true;
    // Flush anything we've heard so far — otherwise the user's
    // mid-sentence Stop click loses the transcript silently.
    clearSilenceTimer();
    const buffered = finalBufferRef.current.trim();
    finalBufferRef.current = "";
    setInterim("");
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
  }, [clearSilenceTimer, onUserUtterance]);

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
    // the tail of turn N-1 plays over the head of turn N.
    if (spokenText.length < lastSpokenTextRef.current.length) {
      spokenSoFarRef.current = 0;
      cancelTts();
    }
    lastSpokenTextRef.current = spokenText;

    const untouched = spokenText.slice(spokenSoFarRef.current);
    const { chunk, rest } = nextSpeakableChunk(untouched);
    if (!chunk) return;

    // Commit this chunk as spoken — even when muted, so we don't
    // reread the chunk once the user un-mutes mid-response.
    spokenSoFarRef.current = spokenText.length - rest.length;

    // Muted: suppress TTS but keep the hands-free loop. When the
    // response ends, we'll still auto-restart listening via the
    // tail-flush effect below.
    if (muted) return;

    // Enqueue. The onFinalChunkEnd callback fires only when the
    // worker has drained the queue AND the turn id still matches —
    // i.e. no newer chunk has been added behind us. That's the
    // right moment to transition state.
    enqueueTts(chunk, () => {
      if (busy) {
        setState("thinking");
      } else if (wantHandsFreeRef.current && enabled) {
        setState("idle");
        setTimeout(() => startListening(), 200);
      } else {
        setState("idle");
      }
    });
  }, [spokenText, enabled, busy, startListening, muted, enqueueTts, cancelTts]);

  // Flush the tail once the agent turn ends (!busy) so we don't
  // drop the last sentence if it didn't end with punctuation. Also
  // enqueued — the worker will pick it up after any chunks still
  // in flight, which prevents the race where the tail flush used
  // to start its own concurrent fetch.
  useEffect(() => {
    if (busy) return;
    if (!enabled || typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;

    const tail = spokenText.slice(spokenSoFarRef.current).trim();
    if (!tail) {
      // Nothing to speak, but we may still need to resume the mic
      // if all chunks are already done.
      if (
        !ttsWorkerRunningRef.current &&
        wantHandsFreeRef.current &&
        enabled &&
        !muted
      ) {
        setState("idle");
        setTimeout(() => startListening(), 200);
      }
      return;
    }

    spokenSoFarRef.current = spokenText.length;

    if (muted) {
      if (wantHandsFreeRef.current && enabled) {
        setState("idle");
        setTimeout(() => startListening(), 200);
      } else {
        setState("idle");
      }
      return;
    }

    enqueueTts(tail, () => {
      if (wantHandsFreeRef.current && enabled) {
        setState("idle");
        setTimeout(() => startListening(), 200);
      } else {
        setState("idle");
      }
    });
  }, [busy, spokenText, enabled, startListening, muted, enqueueTts]);

  // While the network is busy, reflect "thinking" if we're not mid-TTS.
  useEffect(() => {
    if (!enabled) return;
    if (
      busy &&
      typeof window !== "undefined" &&
      !window.speechSynthesis?.speaking
    ) {
      setState("thinking");
    }
  }, [busy, enabled]);

  // ─── J5 — barge-in lifecycle ─────────────────────────────────
  // Open a dedicated mic pipeline while Lumo is speaking. If the user
  // starts talking, cancel TTS and swap to STT. Mic is closed the
  // moment we leave the speaking state so we're never holding a live
  // stream we don't need.
  useEffect(() => {
    if (!enabled) return;
    if (state !== "speaking") return;
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
        console.info("[voice] barge-in unavailable:", err instanceof Error ? err.message : err);
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
  }, [enabled, state, startListening]);

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
  }, [enabled, state, cancelTts]);

  // ─── Presentation ────────────────────────────────────────────
  if (state === "unsupported" && enabled) {
    return (
      <div className="rounded-xl border border-lumo-border bg-lumo-bg-subtle px-3 py-2 text-[12px] text-lumo-fg-low">
        Voice isn't supported in this browser. Try Chrome or Safari on
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

  // Silence the reference to onHandsFreeToggle so it doesn't warn as
  // unused — we keep the prop for API stability but dropped the UI.
  void onHandsFreeToggle;

  const actionVisible =
    state !== "listening" && state !== "thinking" && state !== "speaking";

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

        {/* Status pill */}
        <span
          className={
            "inline-flex items-center gap-1.5 text-[11.5px] uppercase tracking-[0.14em] font-medium " +
            stateToneClass(state)
          }
          aria-live="polite"
        >
          <StatusDot state={state} />
          {stateLabel(state)}
        </span>

        {/* Primary action — shifts with state */}
        {actionVisible ? (
          <button
            type="button"
            onClick={startListening}
            className="ml-auto rounded-full border border-lumo-hair px-4 py-2 text-[13px] text-lumo-fg hover:bg-lumo-elevated transition-colors"
          >
            Tap to talk
          </button>
        ) : null}

        {state === "listening" ? (
          <button
            type="button"
            onClick={stopListening}
            className="ml-auto rounded-full border border-lumo-hair px-4 py-2 text-[13px] text-lumo-fg hover:bg-lumo-elevated transition-colors"
          >
            Stop
          </button>
        ) : null}

        {state === "speaking" ? (
          <button
            type="button"
            onClick={() => {
              if (typeof window !== "undefined") {
                window.speechSynthesis?.cancel();
              }
              stopPremiumAudio();
              setState("idle");
              if (wantHandsFreeRef.current) {
                setTimeout(() => startListening(), 100);
              }
            }}
            className="ml-auto rounded-full border border-lumo-hair px-4 py-2 text-[13px] text-lumo-fg hover:bg-lumo-elevated transition-colors"
          >
            Skip
          </button>
        ) : null}
      </div>

      {interim ? (
        <div className="rounded-xl border border-lumo-hair bg-lumo-elevated/50 px-3 py-2 text-[13.5px]">
          <span className="text-lumo-fg-low">Heard: </span>
          <span className="text-lumo-fg">{interim}</span>
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

function stateLabel(s: VoiceState): string {
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
      return "speaking";
    case "unsupported":
      return "not supported";
    case "error":
      return "error";
  }
}

function stateToneClass(s: VoiceState): string {
  switch (s) {
    case "listening":
      return "text-lumo-accent";
    case "thinking":
      return "text-lumo-fg-low";
    case "speaking":
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
      : state === "speaking"
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
