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
   * When false, the user taps the mic for each turn.
   */
  handsFree: boolean;
  onHandsFreeToggle: (handsFree: boolean) => void;

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
    onUserUtterance,
    spokenText,
    busy,
  } = props;

  const [state, setState] = useState<VoiceState>(enabled ? "idle" : "off");
  const [interim, setInterim] = useState<string>(""); // what user is currently saying
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Refs — mutable state that shouldn't re-render.
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const spokenSoFarRef = useRef<number>(0); // index into spokenText already sent to TTS
  const lastSpokenTextRef = useRef<string>(spokenText);
  const userStoppedListeningRef = useRef<boolean>(false); // user intent to be off
  const wantHandsFreeRef = useRef<boolean>(handsFree);
  useEffect(() => {
    wantHandsFreeRef.current = handsFree;
  }, [handsFree]);

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

    // Stop any current TTS first — user wants to speak now.
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // ignore
    }

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

    // Commit this chunk as spoken.
    spokenSoFarRef.current = spokenText.length - rest.length;

    const u = new SpeechSynthesisUtterance(toSpeakable(chunk));
    if (voiceRef.current) u.voice = voiceRef.current;
    u.rate = 1.05;
    u.pitch = 1.0;
    u.volume = 1.0;
    u.onstart = () => setState("speaking");
    u.onend = () => {
      // If no more utterances are pending, decide what to do next.
      if (
        !window.speechSynthesis.speaking &&
        !window.speechSynthesis.pending
      ) {
        if (busy) {
          setState("thinking");
        } else if (wantHandsFreeRef.current && enabled) {
          // Auto-resume listening for the next user turn — classic
          // hands-free conversational loop.
          setState("idle");
          setTimeout(() => startListening(), 200);
        } else {
          setState("idle");
        }
      }
    };
    u.onerror = () => setState("idle");
    window.speechSynthesis.speak(u);
  }, [spokenText, enabled, busy, startListening]);

  // Flush the tail once the agent turn ends (!busy) so we don't
  // drop the last sentence if it didn't end with punctuation.
  useEffect(() => {
    if (busy) return;
    if (!enabled || typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;

    const tail = spokenText.slice(spokenSoFarRef.current).trim();
    if (!tail) return;

    spokenSoFarRef.current = spokenText.length;
    const u = new SpeechSynthesisUtterance(toSpeakable(tail));
    if (voiceRef.current) u.voice = voiceRef.current;
    u.rate = 1.05;
    u.onstart = () => setState("speaking");
    u.onend = () => {
      if (wantHandsFreeRef.current && enabled) {
        setState("idle");
        setTimeout(() => startListening(), 200);
      } else {
        setState("idle");
      }
    };
    window.speechSynthesis.speak(u);
  }, [busy, spokenText, enabled, startListening]);

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

  // Master toggle — clean shutdown when leaving voice mode.
  useEffect(() => {
    if (!enabled) {
      try {
        recognitionRef.current?.abort();
      } catch {
        // ignore
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={enabled}
          aria-label={enabled ? "Turn off voice" : "Turn on voice"}
          onClick={() => onToggle(!enabled)}
          className={
            "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-medium transition " +
            (enabled
              ? "bg-lumo-accent text-lumo-accent-fg"
              : "border border-lumo-border text-lumo-fg-low hover:text-lumo-fg")
          }
        >
          <MicIcon active={enabled} />
          {enabled ? "Voice on" : "Voice off"}
        </button>

        {enabled ? (
          <>
            <button
              type="button"
              aria-pressed={handsFree}
              onClick={() => onHandsFreeToggle(!handsFree)}
              className={
                "inline-flex items-center rounded-full px-3 py-1.5 text-[12px] transition " +
                (handsFree
                  ? "border border-lumo-accent/50 text-lumo-accent"
                  : "border border-lumo-border text-lumo-fg-low hover:text-lumo-fg")
              }
              title="Auto-listen after each response"
            >
              {handsFree ? "Hands-free" : "Push to talk"}
            </button>

            <span
              className={
                "inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider " +
                stateToneClass(state)
              }
              aria-live="polite"
            >
              <StatusDot state={state} />
              {stateLabel(state)}
            </span>

            {state !== "listening" && state !== "thinking" && state !== "speaking" ? (
              <button
                type="button"
                onClick={startListening}
                className="ml-auto rounded-full border border-lumo-border px-3 py-1.5 text-[12px] text-lumo-fg hover:bg-lumo-bg-subtle"
              >
                Tap to talk
              </button>
            ) : null}

            {state === "listening" ? (
              <button
                type="button"
                onClick={stopListening}
                className="ml-auto rounded-full border border-lumo-border px-3 py-1.5 text-[12px] text-lumo-fg hover:bg-lumo-bg-subtle"
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
                  setState("idle");
                  if (wantHandsFreeRef.current) {
                    setTimeout(() => startListening(), 100);
                  }
                }}
                className="ml-auto rounded-full border border-lumo-border px-3 py-1.5 text-[12px] text-lumo-fg hover:bg-lumo-bg-subtle"
              >
                Skip
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      {enabled && interim ? (
        <div className="rounded-lg border border-lumo-border bg-lumo-bg-subtle px-3 py-2 text-[13px] text-lumo-fg-low">
          <span className="text-lumo-fg-low">heard: </span>
          <span className="text-lumo-fg">{interim}</span>
        </div>
      ) : null}

      {enabled && state === "error" && errorMessage ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-[12px] text-red-400">
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
