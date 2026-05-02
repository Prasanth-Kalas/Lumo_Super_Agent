/**
 * Streaming audio player for TTS responses.
 *
 * Two paths, picked at runtime:
 *
 *   1. MediaSource Extensions (MSE) — the fast path. We attach a
 *      MediaSource to an <audio> element, create a SourceBuffer
 *      with mime "audio/mpeg", and feed chunks from the response's
 *      ReadableStream as they arrive. Playback starts as soon as
 *      the browser has enough buffered to begin (~one MP3 frame,
 *      typically 20-50KB for streamed MP3 at conversational bitrates).
 *
 *   2. Blob fallback — when MSE isn't supported (older Safari, some
 *      mobile browsers) or when the mime isn't acceptable, we buffer
 *      the full response to a Blob and play via object URL. Same
 *      user-visible behavior, just without the early-start benefit.
 *
 * Why audio/mpeg and not an ISO container (mp4/aac): the provider route
 * emits MP3 for broad browser compatibility. MSE accepts MP3 in most
 * browsers (Chrome, Edge, Firefox). Safari desktop works; iOS Safari 17+
 * supports ManagedMediaSource with audio/mpeg too. When detection says no,
 * we fall back — the user just waits for the buffer.
 *
 * Cancellation: `stop()` aborts the fetch reader, tears down the
 * MediaSource, pauses the audio. Idempotent. Safe to call from
 * any state including before playback has started.
 *
 * This module owns only the playback plumbing. State transitions
 * (speaking → idle, hands-free restart) stay in VoiceMode. Callers
 * pass `onStart` + `onEnd` callbacks.
 */

export interface StreamingAudioHandle {
  /** Stop and clean up. Idempotent. */
  stop: () => void;
  /** Resolves when playback ends (naturally or via stop). Never rejects. */
  done: Promise<"played" | "stopped" | "error">;
}

export interface StreamingAudioOpts {
  /** Fires once playback actually begins producing sound. */
  onStart?: () => void;
  /** Fires on playback end. Always fires exactly once; done resolves too. */
  onEnd?: (reason: "played" | "stopped" | "error") => void;
  /** Optional override for the mime type. Defaults to audio/mpeg. */
  mime?: string;
}

/**
 * Feature-detect MSE with MP3 support. Cached after first check.
 */
let mseSupportCache: boolean | null = null;
export function mseSupportsMp3(): boolean {
  if (mseSupportCache !== null) return mseSupportCache;
  if (typeof window === "undefined") return false;
  const ms: typeof MediaSource | undefined =
    (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource;
  if (!ms || typeof ms.isTypeSupported !== "function") {
    mseSupportCache = false;
    return false;
  }
  try {
    mseSupportCache = ms.isTypeSupported("audio/mpeg");
  } catch {
    mseSupportCache = false;
  }
  return mseSupportCache;
}

/**
 * Play an audio stream from a Response. Picks MSE when available,
 * falls back to blob playback. Returns a handle with done + stop.
 */
export function playAudioStream(
  response: Response,
  opts: StreamingAudioOpts = {},
): StreamingAudioHandle {
  if (!response.body) {
    return immediateHandle("error", opts);
  }
  const mime = opts.mime ?? "audio/mpeg";

  if (mseSupportsMp3() && mime === "audio/mpeg") {
    return playViaMse(response, opts);
  }
  return playViaBlob(response, opts);
}

// ──────────────────────────────────────────────────────────────────
// MSE path
// ──────────────────────────────────────────────────────────────────

function playViaMse(
  response: Response,
  opts: StreamingAudioOpts,
): StreamingAudioHandle {
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const audio = new Audio(url);
  audio.preload = "auto";

  let stopped = false;
  let startFired = false;
  let endFired = false;

  const endWith = (reason: "played" | "stopped" | "error") => {
    if (endFired) return;
    endFired = true;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
    opts.onEnd?.(reason);
    resolveDone(reason);
  };

  let resolveDone: (v: "played" | "stopped" | "error") => void = () => {};
  const done = new Promise<"played" | "stopped" | "error">((r) => {
    resolveDone = r;
  });

  audio.addEventListener("playing", () => {
    if (!startFired) {
      startFired = true;
      opts.onStart?.();
    }
  });
  audio.addEventListener("ended", () => endWith("played"));
  audio.addEventListener("error", () => endWith("error"));

  const reader = response.body!.getReader();

  mediaSource.addEventListener("sourceopen", () => {
    if (stopped) return;
    let sourceBuffer: SourceBuffer;
    try {
      sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
    } catch (e) {
      // Some Safari builds say isTypeSupported("audio/mpeg")==true
      // but throw on addSourceBuffer. Fall through to blob.
      console.warn("[streaming-audio] MSE addSourceBuffer failed, falling back:", e);
      stopped = true;
      try {
        mediaSource.endOfStream();
      } catch {
        /* ignore */
      }
      // Re-fetch the remaining body as blob path. Since we already
      // started reading, we'd need to re-request. Instead signal
      // error so the caller can retry via blob — but the caller
      // doesn't know to retry. Safer: surface the failure.
      endWith("error");
      return;
    }

    let pumping = false;
    const pump = async () => {
      if (pumping || stopped) return;
      pumping = true;
      try {
        while (!stopped) {
          if (sourceBuffer.updating) {
            await once(sourceBuffer, "updateend");
            continue;
          }
          const { done: rdone, value } = await reader.read();
          if (rdone) break;
          if (!value || value.byteLength === 0) continue;
          sourceBuffer.appendBuffer(value);
          await once(sourceBuffer, "updateend");
        }
        if (!stopped) {
          try {
            mediaSource.endOfStream();
          } catch {
            // Can throw if readyState isn't "open" — fine, audio
            // will end on its own when the buffer drains.
          }
        }
      } catch (e) {
        console.warn("[streaming-audio] pump failed:", e);
        if (!endFired) endWith("error");
      } finally {
        pumping = false;
      }
    };
    void pump();
  });

  audio.play().catch((e) => {
    // Autoplay policies: play() rejects if the call wasn't preceded
    // by a user gesture. In our UX the user already tapped the mic
    // to turn voice on, so this shouldn't fire — but if it does we
    // surface the error cleanly.
    console.warn("[streaming-audio] audio.play() rejected:", e);
    endWith("error");
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
      try {
        audio.pause();
        audio.src = "";
      } catch {
        /* ignore */
      }
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {
        /* ignore */
      }
      if (!endFired) endWith("stopped");
    },
    done,
  };
}

// ──────────────────────────────────────────────────────────────────
// Blob fallback
// ──────────────────────────────────────────────────────────────────

function playViaBlob(
  response: Response,
  opts: StreamingAudioOpts,
): StreamingAudioHandle {
  let stopped = false;
  let endFired = false;
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;

  const endWith = (reason: "played" | "stopped" | "error") => {
    if (endFired) return;
    endFired = true;
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    opts.onEnd?.(reason);
    resolveDone(reason);
  };

  let resolveDone: (v: "played" | "stopped" | "error") => void = () => {};
  const done = new Promise<"played" | "stopped" | "error">((r) => {
    resolveDone = r;
  });

  void (async () => {
    try {
      const blob = await response.blob();
      if (stopped) return;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.preload = "auto";
      audio.addEventListener("playing", () => opts.onStart?.());
      audio.addEventListener("ended", () => endWith("played"));
      audio.addEventListener("error", () => endWith("error"));
      await audio.play();
    } catch (e) {
      if (!endFired) {
        console.warn("[streaming-audio] blob play failed:", e);
        endWith("error");
      }
    }
  })();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (audio) {
        try {
          audio.pause();
          audio.src = "";
        } catch {
          /* ignore */
        }
      }
      if (!endFired) endWith("stopped");
    },
    done,
  };
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function immediateHandle(
  reason: "played" | "stopped" | "error",
  opts: StreamingAudioOpts,
): StreamingAudioHandle {
  opts.onEnd?.(reason);
  return {
    stop: () => {},
    done: Promise.resolve(reason),
  };
}

function once(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      target.removeEventListener(type, handler);
      resolve();
    };
    target.addEventListener(type, handler, { once: true });
  });
}
