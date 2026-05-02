"use client";

/**
 * VoicePicker — audition + pick Lumo's TTS voice.
 *
 * One card per voice from VOICE_CATALOG. Each card has:
 *   - Name + character chip ("warm female", "deep male" ...)
 *   - One-sentence vibe description
 *   - Preview button — hits /api/tts with a concierge-shaped sample
 *     phrase and the voice's id, plays the stream via the same
 *     MSE-or-blob audio player VoiceMode uses for real responses.
 *     Same path means what you preview is what you hear in-product.
 *   - "Use this voice" button — persists the selection via
 *     setSelectedVoiceId (localStorage).
 *
 * States:
 *   - idle           → not playing, not selected
 *   - selected       → this voice is the active default
 *   - previewing     → audio currently playing for this voice
 *   - unavailable    → /api/tts returned 503 on first preview; show
 *                      a line telling the user premium TTS isn't
 *                      configured and the voice will only affect
 *                      things once the admin sets LUMO_DEEPGRAM_API_KEY.
 *
 * Only one preview plays at a time — starting a new preview stops
 * any in-flight one. Works with or without Deepgram configured;
 * when it's not, the preview button shows a polite unavailable
 * state instead of silently doing nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_CATALOG,
  VOICE_PREVIEW_TEXT,
  getSelectedVoiceId,
  setSelectedVoiceId,
  type VoiceOption,
} from "@/lib/voice-catalog";
import {
  playAudioStream,
  type StreamingAudioHandle,
} from "@/lib/streaming-audio";

type PreviewState = "idle" | "loading" | "playing";
// Three-valued diagnostic instead of a simple boolean: we split the
// "not configured" case (admin hasn't plugged in Deepgram) from the
// "upstream blip" case (proxy is wired up, but the provider itself is
// refusing — billing issue, quota, or transient outage). Same fallback
// behavior; clearer copy so the operator isn't chasing a missing key
// when the real problem is a declined card.
type PremiumStatus = "available" | "not-configured" | "upstream-issue";

export default function VoicePicker() {
  const [selectedId, setSelectedIdState] = useState<string>(VOICE_CATALOG[0]!.id);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>("idle");
  const [premiumStatus, setPremiumStatus] = useState<PremiumStatus>("available");
  const activeRef = useRef<StreamingAudioHandle | null>(null);

  // Hydrate the selected id from localStorage after mount.
  useEffect(() => {
    setSelectedIdState(getSelectedVoiceId());
  }, []);

  // Stop any in-flight preview when the user navigates away.
  useEffect(() => {
    return () => {
      activeRef.current?.stop();
      activeRef.current = null;
    };
  }, []);

  const stopActive = useCallback(() => {
    activeRef.current?.stop();
    activeRef.current = null;
    setPreviewId(null);
    setPreviewState("idle");
  }, []);

  const preview = useCallback(
    async (voice: VoiceOption) => {
      // Tapping the same voice while it's playing = stop.
      if (previewId === voice.id && previewState !== "idle") {
        stopActive();
        return;
      }
      stopActive();

      setPreviewId(voice.id);
      setPreviewState("loading");

      let res: Response;
      try {
        res = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: VOICE_PREVIEW_TEXT,
            voice_id: voice.id,
          }),
        });
      } catch (e) {
        // Pure network failure before the proxy could answer. Treat
        // as an upstream/transport issue rather than misconfiguration.
        console.warn("[voice-picker] /api/tts failed:", e);
        setPremiumStatus("upstream-issue");
        setPreviewState("idle");
        setPreviewId(null);
        return;
      }

      if (!res.ok) {
        // Distinguish between the two failure classes so the banner
        // tells the operator what to actually do:
        //   503 → LUMO_DEEPGRAM_API_KEY isn't set, or upstream returned
        //         401 (which the proxy re-maps to 503). Admin config
        //         issue.
        //   everything else (502 upstream_error / upstream_unreachable,
        //         5xx) → proxy is wired up but the provider itself is
        //         refusing. Usually billing/quota or a brief outage.
        setPremiumStatus(res.status === 503 ? "not-configured" : "upstream-issue");
        setPreviewState("idle");
        setPreviewId(null);
        return;
      }

      setPremiumStatus("available");

      const handle = playAudioStream(res, {
        onStart: () => setPreviewState("playing"),
        onEnd: () => {
          if (activeRef.current === handle) {
            activeRef.current = null;
          }
          setPreviewState("idle");
          setPreviewId(null);
        },
      });
      activeRef.current = handle;
    },
    [previewId, previewState, stopActive],
  );

  const choose = useCallback((voice: VoiceOption) => {
    setSelectedVoiceId(voice.id);
    setSelectedIdState(voice.id);
  }, []);

  return (
    <div className="space-y-4">
      {premiumStatus === "not-configured" ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-600 dark:text-amber-400">
          Premium voice previews aren&apos;t available — your admin
          hasn&apos;t configured Deepgram yet. Pick a voice now and
          it&apos;ll take effect once they do.
        </div>
      ) : premiumStatus === "upstream-issue" ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-600 dark:text-amber-400">
          Premium voice is temporarily unavailable — the provider refused
          the request (often a billing or quota issue). Your admin can
          check the subscription; Lumo will pick it up as soon as
          upstream recovers.
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {VOICE_CATALOG.map((voice) => {
          const isSelected = voice.id === selectedId;
          const isThisPreviewing = previewId === voice.id;
          return (
            <div
              key={voice.id}
              className={
                "rounded-2xl border px-4 py-4 transition-colors " +
                (isSelected
                  ? "border-lumo-accent bg-lumo-accent/5"
                  : "border-lumo-hair bg-gradient-to-br from-lumo-surface to-lumo-bg hover:border-lumo-edge")
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[16px] font-semibold text-lumo-fg">
                      {voice.name}
                    </span>
                    <CharacterChip character={voice.character} />
                  </div>
                  <p className="mt-1.5 text-[13px] text-lumo-fg-mid leading-relaxed">
                    {voice.description}
                  </p>
                </div>
                {isSelected ? (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-lumo-accent">
                    <CheckDot />
                    Active
                  </span>
                ) : null}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void preview(voice)}
                  className="h-8 px-3 rounded-full border border-lumo-hair text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors inline-flex items-center gap-1.5"
                >
                  {isThisPreviewing && previewState === "loading" ? (
                    <>
                      <SpinnerDot />
                      Loading
                    </>
                  ) : isThisPreviewing && previewState === "playing" ? (
                    <>
                      <StopIcon />
                      Stop
                    </>
                  ) : (
                    <>
                      <PlayIcon />
                      Preview
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => choose(voice)}
                  disabled={isSelected}
                  className={
                    "h-8 px-3 rounded-full text-[12.5px] font-medium transition-colors " +
                    (isSelected
                      ? "bg-lumo-accent/20 text-lumo-accent cursor-default"
                      : "bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink")
                  }
                >
                  {isSelected ? "Selected" : "Use this voice"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CharacterChip({ character }: { character: VoiceOption["character"] }) {
  const label: Record<VoiceOption["character"], string> = {
    "warm-female": "warm · female",
    "youthful-female": "youthful · female",
    "british-female": "british · female",
    "warm-male": "warm · male",
    "deep-male": "deep · male",
  };
  return (
    <span className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
      {label[character]}
    </span>
  );
}

function CheckDot() {
  return (
    <span className="inline-block h-1.5 w-1.5 rounded-full bg-lumo-accent shadow-[0_0_6px_rgba(94,234,172,0.6)]" />
  );
}

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
      <path d="M2 1.5 8.5 5 2 8.5V1.5Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
      <rect x="2" y="2" width="6" height="6" rx="1" />
    </svg>
  );
}

function SpinnerDot() {
  return (
    <span className="inline-block h-2 w-2 rounded-full bg-lumo-fg-low animate-pulse" />
  );
}
