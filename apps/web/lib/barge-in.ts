/**
 * Barge-in monitor — detect user speech while Lumo's TTS is playing and
 * fire a callback so the VoiceMode component can cancel playback and
 * start listening.
 *
 * Why a separate module from VoiceMode:
 *   - VoiceMode is already dense. Barge-in has its own audio pipeline
 *     (MediaStream → AudioContext → AnalyserNode) and its own lifecycle.
 *   - If we later swap this implementation for OpenAI Realtime (which
 *     does interruption server-side), we rip out one file, not a
 *     hundred intertwined lines.
 *
 * Approach:
 *   - Ask the browser for a mic stream with echoCancellation +
 *     noiseSuppression + autoGainControl enabled. This meaningfully
 *     reduces Lumo-hearing-itself feedback on laptop speakers;
 *     headphones are even better.
 *   - Feed the stream into an AnalyserNode and sample RMS every ~16ms.
 *   - Treat RMS above a hysteresis threshold (with a short sustain
 *     window) as "user is speaking." Fire the callback ONCE per burst
 *     and pause internally until the user stops so we don't spam.
 *
 * Known limitation: on speakers without great AEC, this will false-
 * positive on Lumo's own voice. Surface this in the UI as "works best
 * with headphones." Accept the tradeoff; the alternative (text-only)
 * is strictly worse.
 */

export interface BargeInHandle {
  /** Stop monitoring and release the mic + audio context. */
  stop: () => void;
}

export interface StartBargeInOptions {
  /** Fired when user speech is detected. Called at most once per burst. */
  onBargeIn: () => void;
  /**
   * RMS threshold in [0, 1]. Default 0.035 — tuned for echo-cancelled
   * laptop speakers. Headphones often allow 0.02. Raise on noisy cafes.
   */
  threshold?: number;
  /**
   * How many consecutive 16ms frames above threshold count as "real"
   * speech (debounce). Default 6 frames ≈ 96ms. Below this you get
   * false positives from keyboard clicks, a cough, a door close.
   */
  sustainFrames?: number;
  /**
   * How long after a burst before we'll fire again. Default 1500ms —
   * one natural sentence. Prevents re-firing on the same continuous
   * utterance.
   */
  coolOffMs?: number;
}

/**
 * Start monitoring. Resolves with a handle once the mic is open.
 * Rejects if the user denied permission or the browser doesn't
 * support the required APIs. Callers should render a gentle fallback
 * ("tap to interrupt") when this fails.
 */
export async function startBargeInMonitor(
  opts: StartBargeInOptions,
): Promise<BargeInHandle> {
  if (typeof window === "undefined" || !navigator?.mediaDevices?.getUserMedia) {
    throw new Error("MediaDevices.getUserMedia unavailable");
  }
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("AudioContext unavailable");
  }

  const threshold = opts.threshold ?? 0.035;
  const sustainFrames = opts.sustainFrames ?? 6;
  const coolOffMs = opts.coolOffMs ?? 1500;

  // Dedicated stream. echoCancellation helps when TTS is on speakers.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const ctx = new AudioCtx();
  // iOS/Safari sometimes ships contexts in suspended state until user
  // gesture. VoiceMode only spins this up from a click handler so this
  // should be fine, but resume defensively.
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      // ignore; monitoring still works in many cases
    }
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let above = 0;
  let lastFiredAt = 0;
  let raf = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buf);

    // RMS over the frame. Cheaper than FFT-band and good enough for
    // "is the user making voice-range sound."
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);

    if (rms > threshold) {
      above += 1;
      if (above >= sustainFrames) {
        const now = performance.now();
        if (now - lastFiredAt > coolOffMs) {
          lastFiredAt = now;
          try {
            opts.onBargeIn();
          } catch (err) {
            console.warn("[barge-in] onBargeIn threw:", err);
          }
        }
      }
    } else {
      above = 0;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      try {
        source.disconnect();
      } catch {
        // ignore
      }
      try {
        void ctx.close();
      } catch {
        // ignore
      }
      // Stop every track on the stream. Without this, the mic indicator
      // stays on after the user ends voice mode — bad UX.
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    },
  };
}
