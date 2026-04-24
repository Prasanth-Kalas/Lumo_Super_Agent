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
  // first successful /api/tts call, or "unavailable" after 503/auth
  // fail (falls back to speechSynthesis for the rest of the session).
  const premiumStatusRef = useRef<"unknown" | "available" | "unavailable">(
    "unknown",
  );
  // Active streaming-audio handle for the in-flight premium TTS
  // chunk, if any. Mute / cancel / barge-in call .stop() on it.
  const activeStreamRef = useRef<StreamingAudioHandle | null>(null);
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

  // ─── STT lifecycle ───────────────────────────────────────────
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

    // Stop any current TTS first — user wants to speak now.
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // ignore
    }
    stopPremiumAudio();

    const rec: SpeechRecognitionLike = new Ctor();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setState("listening");
      setInterim("");
    };
    rec.onresult = (e) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        const alt = r[0];
        if (!alt) continue;
        if (r.isFinal) finalText += alt.transcript;
        else interimText += alt.transcript;
      }
      if (interimText) setInterim(interimText);
      if (finalText) {
        const clean = finalText.trim();
        setInterim("");
        if (clean) {
          userStoppedListeningRef.current = false;
          onUserUtterance(clean);
        }
      }
    };
    rec.onerror = (e) => {
      const code = e.error ?? "unknown";
      if (code === "no-speech" || code === "aborted") {
        // Benign — the user stopped without saying anything. Back to
        // idle without scaring them with a red error state.
        setState("idle");
        return;
      }
      setErrorMessage(code);
      setState("error");
    };
    rec.onend = () => {
      // Release the guard so the next startListening call (on the
      // next agent turn) can create a fresh recognizer.
      if (recognitionRef.current === rec) {
        recognitionRef.current = null;
      }
      // If we're still listening by state (e.g. hands-free loop), no
      // action needed — whoever transitioned us out will handle it.
      // If we ended unexpectedly, drop back to idle.
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
  }, [onUserUtterance]);

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    userStoppedListeningRef.current = true;
    try {
      rec.stop();
    } catch {
      // ignore
    }
    setState("idle");
  }, []);

  // Muting mid-speech should kill in-flight audio immediately; the
  // next TTS effect run will skip speaking (muted branch).
  useEffect(() => {
    if (!muted) return;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    const h = activeStreamRef.current;
    if (h) {
      try {
        h.stop();
      } catch {
        // ignore
      }
    }
    activeStreamRef.current = null;
  }, [muted]);

  // ─── Premium TTS (ElevenLabs via /api/tts) ────────────────────
  //
  // Tries the server-side proxy first. On 503 (key not configured)
  // or any other non-2xx, permanently flips to "unavailable" and
  // falls back to browser speechSynthesis — no thrashing per chunk.
  // Returns a promise that resolves when playback ends OR when
  // premium is unavailable (caller should fall back then).
  const playPremiumTts = useCallback(
    async (
      text: string,
      onStart: () => void,
    ): Promise<"played" | "unavailable" | "aborted"> => {
      if (premiumStatusRef.current === "unavailable") return "unavailable";
      if (typeof window === "undefined") return "unavailable";

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
        return "unavailable";
      }

      if (!res.ok || !res.body) {
        // 503 = not configured; 502 = upstream error. Both fall back.
        // 401 shouldn't reach us (proxy translates to 503) but treat
        // any non-2xx the same: flip to unavailable for the session.
        if (premiumStatusRef.current === "unknown") {
          console.info(
            "[voice] premium TTS unavailable (status",
            res.status + "), using browser fallback",
          );
        }
        premiumStatusRef.current = "unavailable";
        return "unavailable";
      }

      // First successful call — remember so we skip the probe next
      // chunk.
      premiumStatusRef.current = "available";

      // Play via the streaming audio player. With MSE available,
      // playback starts after the first MP3 frame lands in the
      // SourceBuffer — typically within ~400ms of the fetch start
      // for Turbo v2.5. Blob fallback buffers the full response
      // first (same as the prior implementation).
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

  // Stop any in-flight premium audio (used when user cancels /
  // mutes mid-speech / starts a new turn). Delegates to the
  // streaming player's stop() which handles both MSE + blob paths.
  const stopPremiumAudio = useCallback(() => {
    const h = activeStreamRef.current;
    if (h) {
      try {
        h.stop();
      } catch {
        // ignore
      }
    }
    activeStreamRef.current = null;
  }, []);

  // Speak with auto-fallback: tries premium first, falls through
  // to speechSynthesis on failure. onStart fires once audio starts
  // playing; returns a promise that resolves when playback ends.
  const speakWithFallback = useCallback(
    async (text: string, onStart: () => void): Promise<void> => {
      if (!text.trim()) return;
      const speakable = toSpeakable(text);

      // Try premium first.
      const premium = await playPremiumTts(speakable, onStart);
      if (premium === "played" || premium === "aborted") return;

      // Premium unavailable — fall back to browser speechSynthesis.
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

  // ─── TTS: speak the next sentence as assistant text grows ────
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;

    // Agent turn just started (spokenText reset). Clear buffer.
    if (spokenText.length < lastSpokenTextRef.current.length) {
      spokenSoFarRef.current = 0;
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

    // Fire and forget. speakWithFallback tries premium first, falls
    // back to speechSynthesis on failure. State transitions fire
    // when playback actually starts + when it ends.
    void speakWithFallback(chunk, () => setState("speaking")).then(() => {
      // Decide next state. For speechSynthesis we used to check
      // the global queue here — with the Audio-element path there's
      // no global queue, so we just act on the in-flight promise's
      // completion.
      if (busy) {
        setState("thinking");
      } else if (wantHandsFreeRef.current && enabled) {
        setState("idle");
        setTimeout(() => startListening(), 200);
      } else {
        setState("idle");
      }
    });
  }, [spokenText, enabled, busy, startListening, muted, speakWithFallback]);

  // Flush the tail once the agent turn ends (!busy) so we don't
  // drop the last sentence if it didn't end with punctuation.
  useEffect(() => {
    if (busy) return;
    if (!enabled || typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;

    const tail = spokenText.slice(spokenSoFarRef.current).trim();
    if (!tail) return;

    spokenSoFarRef.current = spokenText.length;

    // Muted tail: skip TTS, still resume listening so the
    // conversational loop keeps working.
    if (muted) {
      if (wantHandsFreeRef.current && enabled) {
        setState("idle");
        setTimeout(() => startListening(), 200);
      } else {
        setState("idle");
      }
      return;
    }

    void speakWithFallback(tail, () => setState("speaking")).then(() => {
      if (wantHandsFreeRef.current && enabled) {
        setState("idle");
        setTimeout(() => startListening(), 200);
      } else {
        setState("idle");
      }
    });
  }, [busy, spokenText, enabled, startListening, muted, speakWithFallback]);

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
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      stopPremiumAudio();
      setState("off");
      setInterim("");
      return;
    }
    if (state === "off" && supportedRef.current) setState("idle");
    if (state === "off" && !supportedRef.current) setState("unsupported");
  }, [enabled, state]);

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
