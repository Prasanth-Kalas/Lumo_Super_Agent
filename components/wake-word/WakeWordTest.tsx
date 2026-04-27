"use client";

/**
 * WakeWordTest — a 30-second test harness so the user can try
 * "Hey Lumo" detection BEFORE committing to enabling the engine
 * persistently.
 *
 * Why this exists:
 *   ADR-010 §6 specifies a 5-second test capture in the consent flow
 *   to verify the mic works. We're going slightly longer (30 seconds)
 *   here to actually let the user try saying the wake word. The 5s
 *   mic check is a strict subset of what this surface does.
 *
 *   Quality targets in ADR-010 §5 are "TPR ≥ 95%, FAR < 1/24h" — but
 *   measured on a held-out set, not on a single user's first try. The
 *   test harness is for *user calibration*: does the user trust the
 *   detector enough to leave it on? If they don't, they say no in
 *   settings, no harm done.
 *
 * Behavior:
 *   - 30-second window, counting down. User can stop early.
 *   - During the window, the engine listens for "Hey Lumo." Each
 *     fire bumps a counter and shows a green flash.
 *   - At end-of-window, we surface a small summary: "Detected N
 *     times in 30 seconds." If 0, we suggest the sensitivity slider
 *     or tell the user the mic might be too quiet.
 *   - This component runs the engine in *test mode only* — no audit
 *     row for `wake_word_enabled` is written, no post-wake STT
 *     capture happens. (Codex WAKE-1 implements the test mode
 *     boundary on the engine side.)
 *
 * Accessibility:
 *   - Start/stop button is full-size and keyboard-reachable.
 *   - Each detection event triggers an aria-live "Detected" call so
 *     screen reader users hear what the visual user sees.
 *   - Countdown is announced every 5 seconds, not every second
 *     (avoids drowning the user in chatter).
 */

import { useCallback, useEffect, useRef, useState } from "react";

const TEST_WINDOW_S = 30;

export interface WakeWordTestProps {
  /** Optional sensitivity level the engine should use for the test.
   *  Mirrors the per-user setting in ADR-010 §10 risk row 2 (3
   *  levels). The test runs at the same level the user has selected. */
  sensitivity?: "low" | "medium" | "high";
  /** Disabled while the user has not granted mic permission yet, etc. */
  disabled?: boolean;
}

export function WakeWordTest({ sensitivity = "medium", disabled = false }: WakeWordTestProps) {
  const [running, setRunning] = useState(false);
  const [remainingS, setRemainingS] = useState(TEST_WINDOW_S);
  const [detectionCount, setDetectionCount] = useState(0);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const tickRef = useRef<number | null>(null);
  const announceRef = useRef<HTMLSpanElement>(null);

  // ----- Codex WAKE-1 stubs -----
  async function startTestMode(_opts: { sensitivity: string }): Promise<void> {
    /* TODO: Codex WAKE-1 — instantiate the wake-word engine in
     * "test" mode (no post-wake STT, no audit writes). Wire the
     * returned detection events to onDetection() below. */
  }

  async function stopTestMode(): Promise<void> {
    /* TODO: Codex WAKE-1 — engine.stop() + tear down audio worklet. */
  }
  // ----- end stubs -----

  const onDetection = useCallback(() => {
    setDetectionCount((c) => c + 1);
    setFlash(true);
    if (announceRef.current) {
      announceRef.current.textContent = "Detected.";
    }
    window.setTimeout(() => setFlash(false), 800);
  }, []);

  // Expose the detection callback so Codex's engine can dispatch
  // through it once the stubs are filled in. We hang it on the window
  // for the dev/test build only — Codex will plumb a proper ref.
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as { __lumoWakeTestOnDetect?: () => void }).__lumoWakeTestOnDetect =
      onDetection;
    return () => {
      delete (window as unknown as { __lumoWakeTestOnDetect?: () => void })
        .__lumoWakeTestOnDetect;
    };
  }, [onDetection]);

  const stopAll = useCallback(async () => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setRunning(false);
    try {
      await stopTestMode();
    } catch {
      /* ignore */
    }
  }, []);

  const handleStart = useCallback(async () => {
    setError(null);
    setDetectionCount(0);
    setRemainingS(TEST_WINDOW_S);
    setCompleted(false);
    try {
      await startTestMode({ sensitivity });
      setRunning(true);
      tickRef.current = window.setInterval(() => {
        setRemainingS((s) => {
          const next = s - 1;
          if (next <= 0) {
            void stopAll();
            setCompleted(true);
            return 0;
          }
          return next;
        });
      }, 1000);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Couldn't start the test: ${e.message}`
          : "Couldn't start the test.",
      );
    }
  }, [sensitivity, stopAll]);

  const handleStop = useCallback(async () => {
    await stopAll();
    setCompleted(true);
  }, [stopAll]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void stopAll();
    };
  }, [stopAll]);

  // Announce remaining time every 5 seconds.
  useEffect(() => {
    if (!running) return;
    if (remainingS > 0 && remainingS % 5 === 0 && announceRef.current) {
      announceRef.current.textContent = `${remainingS} seconds left.`;
    }
  }, [remainingS, running]);

  const summary = (() => {
    if (!completed) return null;
    if (detectionCount === 0) {
      return "We didn't hear a wake word. Try moving closer to the mic, or raise the sensitivity in settings before turning the feature on.";
    }
    if (detectionCount === 1) {
      return "Detected once. Looks like the engine can hear you. You can turn it on with confidence.";
    }
    return `Detected ${detectionCount} times in ${TEST_WINDOW_S} seconds. Sounds responsive — turn it on whenever you're ready.`;
  })();

  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4">
      <div className="space-y-1.5">
        <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg">
          Test &quot;Hey Lumo&quot;
        </h2>
        <p className="text-[13px] text-lumo-fg-mid leading-relaxed">
          A short, optional test. Lumo listens locally for 30 seconds —
          nothing leaves your device. Say &quot;Hey Lumo&quot; a few times
          to make sure the engine catches you. You can turn the feature
          on or off afterwards.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={running ? () => void handleStop() : () => void handleStart()}
          disabled={disabled}
          className={[
            "h-10 px-4 rounded-md text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
            running
              ? "bg-red-500 text-white hover:bg-red-600"
              : "bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink",
          ].join(" ")}
          aria-pressed={running}
        >
          {running ? "Stop test" : "Start 30-second test"}
        </button>

        {running ? (
          <span className="text-[12.5px] text-lumo-fg-mid num">
            {remainingS}s remaining · Detected{" "}
            <span className="text-lumo-fg font-semibold">{detectionCount}</span>
          </span>
        ) : null}

        {completed && !running ? (
          <span className="text-[12.5px] text-lumo-fg-mid num">
            Detected{" "}
            <span className="text-lumo-fg font-semibold">{detectionCount}</span>{" "}
            time{detectionCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {/* The flash card — visual + audible indicator each time the
          wake word fires during the test. */}
      <div
        className={[
          "rounded-md border px-3 py-3 transition-colors",
          flash
            ? "border-lumo-ok bg-lumo-ok/15 text-lumo-ok"
            : "border-lumo-hair bg-lumo-bg/40 text-lumo-fg-low",
        ].join(" ")}
        aria-hidden="true"
      >
        <div className="text-[12.5px]">
          {flash ? "✓ Detected" : running ? "Listening…" : "Idle"}
        </div>
      </div>

      {summary ? (
        <p className="text-[13px] text-lumo-fg-high leading-relaxed">{summary}</p>
      ) : null}

      <span ref={announceRef} className="sr-only" aria-live="polite" />
    </div>
  );
}

export default WakeWordTest;
