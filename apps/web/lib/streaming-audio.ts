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

export interface ChunkedAudioPlayer extends StreamingAudioHandle {
  /**
   * Append another provider response to the same playback session.
   * Resolves once all bytes from this response are appended to the
   * underlying audio pipeline, not once the audio has finished playing.
   */
  appendResponse: (
    response: Response,
  ) => Promise<"appended" | "stopped" | "error">;
  /**
   * Signal that no more chunks are coming. The player ends the stream
   * only after the append queue drains, then resolves when audio playback
   * naturally finishes.
   */
  finish: () => Promise<"played" | "stopped" | "error">;
}

interface ChunkedAudioPlayerTestHooks {
  supportsMse?: boolean;
  mediaSourceFactory?: () => MediaSourceLike;
  audioFactory?: (url: string) => AudioLike;
  urlFactory?: UrlFactoryLike;
}

export interface ChunkedAudioPlayerOpts extends StreamingAudioOpts {
  testHooks?: ChunkedAudioPlayerTestHooks;
}

interface SourceBufferLike extends EventTarget {
  updating: boolean;
  appendBuffer(data: BufferSource): void;
}

interface MediaSourceLike extends EventTarget {
  readyState: string;
  addSourceBuffer(mime: string): SourceBufferLike;
  endOfStream(): void;
}

interface AudioLike extends EventTarget {
  preload: string;
  src: string;
  duration: number;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

interface UrlFactoryLike {
  createObjectURL(value: unknown): string;
  revokeObjectURL(url: string): void;
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

/**
 * Create a multi-response MP3 player. Deepgram REST Speak returns one MP3
 * stream per /api/tts request; VoiceMode chunks long assistant replies into
 * sentence-sized requests. This player appends those separate MP3 byte streams
 * into one MediaSource so sentence N+1 can buffer before sentence N ends.
 *
 * This is intentionally separate from playAudioStream(), which still plays one
 * standalone response for voice previews and other simple callers.
 */
export function createChunkedAudioPlayer(
  opts: ChunkedAudioPlayerOpts = {},
): ChunkedAudioPlayer {
  const mime = opts.mime ?? "audio/mpeg";
  const supportsMse = opts.testHooks?.supportsMse ?? mseSupportsMp3();
  if (!supportsMse || mime !== "audio/mpeg") {
    return createSequentialBlobChunkPlayer(opts);
  }
  return createMseChunkPlayer(opts);
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
// Multi-chunk MSE path
// ──────────────────────────────────────────────────────────────────

function createMseChunkPlayer(
  opts: ChunkedAudioPlayerOpts,
): ChunkedAudioPlayer {
  const mediaSource =
    opts.testHooks?.mediaSourceFactory?.() ?? new MediaSource();
  const urlFactory = opts.testHooks?.urlFactory ?? URL;
  const url = urlFactory.createObjectURL(mediaSource);
  const audio = opts.testHooks?.audioFactory?.(url) ?? new Audio(url);
  audio.preload = "auto";

  let stopped = false;
  let startFired = false;
  let endFired = false;
  let sourceBuffer: SourceBufferLike | null = null;
  let appendTail: Promise<unknown> = Promise.resolve();
  let sourceReadyResolve: () => void = () => {};
  let sourceReadyReject: (reason?: unknown) => void = () => {};
  let resolveDone: (v: "played" | "stopped" | "error") => void = () => {};

  const sourceReady = new Promise<void>((resolve, reject) => {
    sourceReadyResolve = resolve;
    sourceReadyReject = reject;
  });
  void sourceReady.catch(() => undefined);
  const done = new Promise<"played" | "stopped" | "error">((resolve) => {
    resolveDone = resolve;
  });

  const endWith = (reason: "played" | "stopped" | "error") => {
    if (endFired) return;
    endFired = true;
    try {
      urlFactory.revokeObjectURL(url);
    } catch {
      // ignore
    }
    opts.onEnd?.(reason);
    resolveDone(reason);
  };

  audio.addEventListener("playing", () => {
    if (startFired) return;
    startFired = true;
    opts.onStart?.();
  });
  audio.addEventListener("ended", () => endWith("played"));
  audio.addEventListener("error", () => endWith("error"));

  mediaSource.addEventListener("sourceopen", () => {
    if (stopped) return;
    try {
      sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
      sourceReadyResolve();
    } catch (error) {
      console.warn("[streaming-audio] chunked MSE addSourceBuffer failed:", error);
      stopped = true;
      sourceReadyReject(error);
      endWith("error");
    }
  });

  audio.play().catch((error) => {
    console.warn("[streaming-audio] chunked audio.play() rejected:", error);
    endWith("error");
  });

  const appendResponse = (
    response: Response,
  ): Promise<"appended" | "stopped" | "error"> => {
    appendTail = appendTail.then(() => appendResponseBody(response));
    return appendTail as Promise<"appended" | "stopped" | "error">;
  };

  const appendResponseBody = async (
    response: Response,
  ): Promise<"appended" | "stopped" | "error"> => {
    if (stopped) return "stopped";
    if (!response.body) return "error";
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      await sourceReady;
      if (stopped) return "stopped";
      if (!sourceBuffer) return "error";
      reader = response.body.getReader();
      while (!stopped) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        if (!value || value.byteLength === 0) continue;
        if (sourceBuffer.updating) {
          await once(sourceBuffer, "updateend");
        }
        const appendable = new Uint8Array(value.byteLength);
        appendable.set(value);
        sourceBuffer.appendBuffer(appendable.buffer as ArrayBuffer);
        await once(sourceBuffer, "updateend");
      }
      return stopped ? "stopped" : "appended";
    } catch (error) {
      if (!stopped) {
        console.warn("[streaming-audio] chunked append failed:", error);
        endWith("error");
      }
      return stopped ? "stopped" : "error";
    } finally {
      if (stopped && reader) {
        await reader.cancel().catch(() => undefined);
      }
    }
  };

  const finish = async (): Promise<"played" | "stopped" | "error"> => {
    try {
      await appendTail;
      await sourceReady.catch(() => undefined);
      if (!stopped && sourceBuffer?.updating) {
        await once(sourceBuffer, "updateend");
      }
      if (!stopped && mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {
          // If the readyState changes between the guard and call, let the
          // audio element's natural ended/error events settle the promise.
        }
      }
    } catch {
      if (!endFired) endWith("error");
    }
    // Chrome MSE quirk: after endOfStream(), the <audio> element's
    // `ended` event sometimes doesn't fire — currentTime lands a
    // hair short of duration and the natural end is never signalled.
    // Without this fallback, `done` never resolves → the TTS worker
    // hangs awaiting finish() → voice state machine stays stuck on
    // "speaking" and the mic gate never reopens (no tap-to-talk
    // button after the first turn).
    //
    // Primary recovery: detect "currentTime reached duration" via
    // timeupdate (fires while playing, regardless of `ended`). The
    // long-tail timeout is a backstop for the truly-paused case.
    const onTimeUpdate = () => {
      const dur = audio.duration;
      if (Number.isFinite(dur) && dur > 0 && audio.currentTime >= dur - 0.05) {
        if (!endFired) endWith("played");
      }
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    const watchdog = setTimeout(() => {
      if (!endFired) endWith("played");
    }, 30_000);
    try {
      return await done;
    } finally {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      clearTimeout(watchdog);
    }
  };

  return {
    appendResponse,
    finish,
    stop: () => {
      if (stopped) return;
      stopped = true;
      sourceReadyReject(new Error("chunked_audio_stopped"));
      try {
        audio.pause();
        audio.src = "";
      } catch {
        // ignore
      }
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {
        // ignore
      }
      endWith("stopped");
    },
    done,
  };
}

// Blob fallback keeps correctness on browsers that do not support MP3 MSE.
// It is intentionally not the primary path because it introduces a small
// inter-sentence gap; Chrome/macOS production should use createMseChunkPlayer.
function createSequentialBlobChunkPlayer(
  opts: ChunkedAudioPlayerOpts,
): ChunkedAudioPlayer {
  let stopped = false;
  let finalRequested = false;
  let current: StreamingAudioHandle | null = null;
  let queueTail: Promise<unknown> = Promise.resolve();
  let resolveDone: (v: "played" | "stopped" | "error") => void = () => {};
  const done = new Promise<"played" | "stopped" | "error">((resolve) => {
    resolveDone = resolve;
  });

  const appendResponse = (
    response: Response,
  ): Promise<"appended" | "stopped" | "error"> => {
    queueTail = queueTail.then(async () => {
      if (stopped) return "stopped";
      current = playAudioStream(response, {
        ...opts,
        // The chunked player's onEnd represents the whole turn, not
        // each fallback chunk. Preserve onStart for the first audible
        // chunk, but fire final onEnd only from finish().
        onEnd: undefined,
      });
      const result = await current.done;
      current = null;
      return result === "played" ? "appended" : result;
    });
    return queueTail as Promise<"appended" | "stopped" | "error">;
  };

  const finish = async (): Promise<"played" | "stopped" | "error"> => {
    finalRequested = true;
    const result = await (queueTail as Promise<
      "appended" | "stopped" | "error"
    >).catch(() => "error" as const);
    const reason =
      result === "appended" ? "played" : result === "stopped" ? "stopped" : "error";
    resolveDone(reason);
    opts.onEnd?.(reason);
    return reason;
  };

  return {
    appendResponse,
    finish,
    stop: () => {
      if (stopped) return;
      stopped = true;
      current?.stop();
      if (!finalRequested) {
        resolveDone("stopped");
        opts.onEnd?.("stopped");
      }
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
