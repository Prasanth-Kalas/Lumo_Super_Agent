"use client";

/**
 * SampleRecorder — the prompt-driven 30-90s recording surface.
 *
 * ADR-012 §5.2 says the user reads three sentences shown on screen,
 * the audio captured here lands in the dedicated voice_cloning_samples
 * bucket, and re-recording or cancelling deletes any partials. This
 * component does the *UI* for that flow. Codex VOICE-1 owns the
 * actual MediaRecorder + signed-URL upload — those are stubbed.
 *
 * The script:
 *   We deliberately picked three sentences that (a) include a wide
 *   phoneme spread for the cloning model, (b) mention Lumo by name
 *   so the recording cannot be plausibly mistaken for a non-Lumo
 *   voice sample, (c) read naturally so the user doesn't sound
 *   stilted. Codex can swap the sentences in `RECORDING_SCRIPT`
 *   below without rewriting this component.
 *
 * Visual contract:
 *   - The active sentence is large, the other two are dimmed.
 *   - The mic button is BIG and obvious. When recording, it pulses
 *     and reads "Recording — tap to stop." There is never a silent
 *     state where audio is being captured without a visible cue.
 *   - A live duration counter and a 90s hard cap.
 *   - Per-sentence "Re-record" so the user can fix one without
 *     redoing all three.
 *   - Cancel button visible at all times. Cancel = ditch all
 *     captured samples + write consent_revoked (parent decides
 *     what API call to make).
 *
 * Accessibility:
 *   - Mic button has aria-pressed reflecting recording state.
 *   - Duration is announced via an aria-live polite region every
 *     few seconds.
 *   - Stop button is reachable via Tab even while recording (it IS
 *     the mic button in stop-state).
 *   - Visual recording indicator pairs with a screen-reader-only
 *     "Recording in progress" text.
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface RecordingScriptLine {
  id: string;
  text: string;
  hint?: string;
}

const RECORDING_SCRIPT: RecordingScriptLine[] = [
  {
    id: "line_1",
    text: "Hi Lumo, this is my voice. I'm setting up a private voice profile so you can read my drafts back to me in a way that sounds like me.",
    hint: "Say it the way you'd say it to a friend — no need to perform.",
  },
  {
    id: "line_2",
    text: "Today is Monday and I'm reviewing what's on my plate. Please summarize my morning, then read the first email out loud.",
    hint: "Natural pace. The longer pauses help the model.",
  },
  {
    id: "line_3",
    text: "If anything changes, I'll come back to settings and re-record. I understand my recordings are deleted within twenty-four hours.",
    hint: "End on a steady tone. This sentence anchors the cloned cadence.",
  },
];

const PER_SENTENCE_MIN_S = 4;
const PER_SENTENCE_MAX_S = 30;
const TOTAL_MAX_S = 90;

export interface SampleRecorderProps {
  /** Fired when all three samples are captured and the user confirms.
   *  Parent passes the captured blobs/refs to the cloning service. */
  onSamplesReady: (samples: { lineId: string; durationMs: number }[]) => void;
  /** Fired when the user cancels mid-flow. Parent must purge any
   *  partial uploads and write a consent_revoked audit row. */
  onCancel: () => void;
}

interface CapturedSample {
  lineId: string;
  durationMs: number;
}

export function SampleRecorder({ onSamplesReady, onCancel }: SampleRecorderProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [captured, setCaptured] = useState<Record<string, CapturedSample>>({});
  const [error, setError] = useState<string | null>(null);
  const startRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  const activeLine = RECORDING_SCRIPT[activeIdx]!;
  const totalCapturedMs = Object.values(captured).reduce(
    (acc, s) => acc + s.durationMs,
    0,
  );
  const allDone =
    Object.keys(captured).length === RECORDING_SCRIPT.length &&
    RECORDING_SCRIPT.every((l) => captured[l.id]);

  // ----- Codex VOICE-1 will replace these stubs -----
  async function startRecording(): Promise<void> {
    /* TODO: Codex VOICE-1 — request mic permission, instantiate
     * MediaRecorder against the voice_cloning_samples signed URL,
     * begin streaming PCM frames. Reject if permission denied. */
  }

  async function stopRecording(): Promise<{ durationMs: number }> {
    /* TODO: Codex VOICE-1 — stop MediaRecorder, finalize upload,
     * return durationMs from the encoder. UI uses elapsedMs as a
     * proxy until then. */
    return { durationMs: elapsedMs };
  }

  async function discardSample(_lineId: string): Promise<void> {
    /* TODO: Codex VOICE-1 — DELETE the per-sentence object from the
     * voice_cloning_samples bucket. Logs nothing client-side. */
  }
  // ----- end stubs -----

  const stopTick = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  // Hard cap — if the user blows past PER_SENTENCE_MAX_S we stop
  // automatically. Better than recording forever and uploading garbage.
  const handleStop = useCallback(async () => {
    stopTick();
    setIsRecording(false);
    try {
      const { durationMs } = await stopRecording();
      const finalDuration = durationMs > 0 ? durationMs : elapsedMs;
      const lineId = activeLine.id;
      if (finalDuration < PER_SENTENCE_MIN_S * 1000) {
        setError(
          `That clip was too short. Read the sentence at a natural pace — at least ${PER_SENTENCE_MIN_S} seconds.`,
        );
        await discardSample(lineId);
      } else {
        setCaptured((c) => ({
          ...c,
          [lineId]: { lineId, durationMs: finalDuration },
        }));
        // Auto-advance to the next unrecorded line.
        const nextIdx = RECORDING_SCRIPT.findIndex(
          (l, i) => i > activeIdx && !captured[l.id],
        );
        if (nextIdx !== -1) setActiveIdx(nextIdx);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setElapsedMs(0);
    startRef.current = null;
  }, [activeIdx, activeLine.id, captured, elapsedMs, stopTick]);

  const handleStart = useCallback(async () => {
    setError(null);
    try {
      await startRecording();
      startRef.current = Date.now();
      setElapsedMs(0);
      setIsRecording(true);
      tickRef.current = window.setInterval(() => {
        if (startRef.current === null) return;
        const ms = Date.now() - startRef.current;
        setElapsedMs(ms);
        if (ms >= PER_SENTENCE_MAX_S * 1000) {
          void handleStop();
        }
      }, 100);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Couldn't start recording: ${e.message}`
          : "Couldn't start recording.",
      );
    }
  }, [handleStop]);

  // Cleanup any active capture on unmount — defense-in-depth so that
  // a route change can't strand an open mic.
  useEffect(() => {
    return () => {
      stopTick();
      if (isRecording) {
        void stopRecording().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reRecord(idx: number) {
    const lineId = RECORDING_SCRIPT[idx]!.id;
    void discardSample(lineId);
    setCaptured((c) => {
      const { [lineId]: _drop, ...rest } = c;
      return rest;
    });
    setActiveIdx(idx);
  }

  const elapsedS = Math.floor(elapsedMs / 1000);
  const elapsedDisp = `${String(Math.floor(elapsedS / 60)).padStart(1, "0")}:${String(elapsedS % 60).padStart(2, "0")}`;
  const totalCapturedS = Math.floor(totalCapturedMs / 1000);

  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] sm:text-[20px] font-semibold tracking-[-0.02em] text-lumo-fg">
            Read three sentences
          </h2>
          <p className="mt-1 text-[13px] text-lumo-fg-mid leading-relaxed">
            Total recording: about 30–90 seconds. You can re-record any
            sentence. Audio uploads only after you confirm at the end.
          </p>
        </div>
        <span
          className="text-[11.5px] text-lumo-fg-mid border border-lumo-hair rounded-full px-2.5 py-1 num"
          aria-label={`${totalCapturedS} of ${TOTAL_MAX_S} seconds captured`}
        >
          {totalCapturedS}s / {TOTAL_MAX_S}s
        </span>
      </div>

      {/* The script — active line is large, others dimmed. */}
      <ol className="space-y-3" role="list">
        {RECORDING_SCRIPT.map((line, idx) => {
          const isActive = idx === activeIdx;
          const isDone = !!captured[line.id];
          return (
            <li
              key={line.id}
              className={[
                "rounded-md border p-4 transition-colors",
                isActive
                  ? "border-lumo-accent/40 bg-lumo-bg/60"
                  : "border-lumo-hair bg-lumo-bg/30",
              ].join(" ")}
              aria-current={isActive ? "step" : undefined}
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-[11px] font-mono text-lumo-fg-low uppercase tracking-wider">
                  Sentence {idx + 1}
                </span>
                {isDone ? (
                  <span className="text-[11px] text-lumo-ok flex items-center gap-1">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2.5 6.5l2.5 2.5 4.5-5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                    Captured
                  </span>
                ) : null}
              </div>
              <p
                className={[
                  "leading-relaxed",
                  isActive
                    ? "text-[16px] sm:text-[17px] text-lumo-fg"
                    : "text-[13.5px] text-lumo-fg-mid",
                ].join(" ")}
              >
                {line.text}
              </p>
              {isActive && line.hint ? (
                <p className="mt-2 text-[12px] text-lumo-fg-low italic">
                  {line.hint}
                </p>
              ) : null}
              {isDone ? (
                <button
                  type="button"
                  onClick={() => reRecord(idx)}
                  className="mt-2 text-[12px] text-lumo-fg-mid hover:text-lumo-fg underline decoration-lumo-fg-low underline-offset-2"
                >
                  Re-record sentence {idx + 1}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500"
        >
          {error}
        </div>
      ) : null}

      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {isRecording
          ? `Recording sentence ${activeIdx + 1}, ${elapsedS} seconds elapsed.`
          : ""}
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
        {/* The mic button. Big. Obvious. Same control toggles
            start/stop so the visible UI is always honest about
            whether the mic is open. */}
        <button
          type="button"
          onClick={isRecording ? () => void handleStop() : () => void handleStart()}
          aria-pressed={isRecording}
          aria-label={
            isRecording
              ? `Stop recording sentence ${activeIdx + 1}`
              : `Start recording sentence ${activeIdx + 1}`
          }
          disabled={allDone}
          className={[
            "flex items-center justify-center gap-2.5 h-12 px-5 rounded-md text-[14px] font-medium transition-colors",
            isRecording
              ? "bg-red-500 text-white hover:bg-red-600 animate-pulse"
              : "bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:opacity-40",
          ].join(" ")}
        >
          {isRecording ? (
            <>
              <span
                className="inline-block h-3 w-3 rounded-sm bg-white"
                aria-hidden="true"
              />
              <span>Stop — {elapsedDisp}</span>
            </>
          ) : (
            <>
              <MicGlyph />
              <span>
                {captured[activeLine.id]
                  ? "Re-record this sentence"
                  : `Record sentence ${activeIdx + 1}`}
              </span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="h-12 px-4 rounded-md text-[13px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
        >
          Cancel and discard recordings
        </button>

        <div className="sm:ml-auto">
          <button
            type="button"
            onClick={() =>
              onSamplesReady(
                RECORDING_SCRIPT.map((l) => captured[l.id]!).filter(Boolean),
              )
            }
            disabled={!allDone || isRecording}
            className="h-12 px-5 rounded-md bg-lumo-accent text-lumo-accent-ink text-[13px] font-medium hover:bg-lumo-accent-dim transition-colors disabled:opacity-40 disabled:cursor-not-allowed w-full sm:w-auto"
          >
            {allDone ? "Submit recordings for cloning" : "Submit (record all 3 first)"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MicGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="6"
        y="2"
        width="4"
        height="8"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3.5 7.5v.5a4.5 4.5 0 0 0 9 0v-.5M8 12.5v2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default SampleRecorder;
