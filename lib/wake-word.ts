/**
 * Wake-word scaffold.
 *
 * Today this is a no-op: `startWakeWord()` checks for
 * NEXT_PUBLIC_PORCUPINE_ACCESS_KEY; if missing it returns a
 * gracefully-disabled handle and the VoiceMode shows "tap mic to talk"
 * as usual. When the key is present AND the Porcupine web SDK is
 * installed, this module dynamically imports it and wires up the
 * "Hey Lumo" keyword.
 *
 * Why dynamic import: Porcupine ships ~1MB of WASM we don't want in
 * every client bundle by default. Splitting it behind an env-var gate
 * keeps text-mode users lean and lets you ship real wake-word the
 * moment you sign up for a Picovoice key.
 *
 * To enable:
 *   1. `npm i @picovoice/porcupine-web`
 *   2. Get a free access key from console.picovoice.ai
 *   3. Set NEXT_PUBLIC_PORCUPINE_ACCESS_KEY in Vercel env
 *   4. Drop your custom "hey-lumo.ppn" under /public/porcupine/ (or
 *      use a built-in keyword — the code below defaults to "computer"
 *      so you can smoke-test without training a custom model)
 *
 * Until then, this module is inert and the rest of VoiceMode works.
 */

export interface WakeWordHandle {
  /** Stop listening for the wake word and release resources. */
  stop: () => void;
  /** True if the engine is actually running (vs. the scaffold no-op). */
  active: boolean;
}

export interface StartWakeWordOptions {
  /**
   * Fired when the wake word is detected. VoiceMode should transition
   * to "listening" and start STT.
   */
  onWake: () => void;
  /**
   * Which built-in or custom keyword to listen for. Built-ins live in
   * the Porcupine SDK; "computer", "jarvis", "picovoice" are three
   * sensible placeholders. Custom keywords point at a .ppn file URL
   * served from /public/porcupine/<name>.ppn.
   *
   * When we trial-train "Hey Lumo" the answer becomes
   * `{ custom: { publicPath: "/porcupine/hey-lumo.ppn", label: "Hey Lumo" } }`.
   */
  keyword?:
    | { builtin: string }
    | { custom: { publicPath: string; label: string } };
}

/**
 * Returns immediately with a no-op handle if the key or SDK isn't
 * present. Callers never need to special-case "wake word unavailable."
 */
export async function startWakeWord(
  opts: StartWakeWordOptions,
): Promise<WakeWordHandle> {
  const noop: WakeWordHandle = { stop: () => {}, active: false };

  // Server-side render or very old browsers: bail.
  if (typeof window === "undefined") return noop;

  const key = (process.env.NEXT_PUBLIC_PORCUPINE_ACCESS_KEY ?? "").trim();
  if (!key) return noop;

  // Try to load the SDK lazily. If it's not installed, stay silent —
  // logging a warn every session load would spam dev consoles.
  //
  // The module specifier is built from a computed string so TypeScript
  // does NOT statically resolve it at typecheck time. Without this,
  // anyone who clones the repo without the Porcupine package installed
  // would see a "Cannot find module" error before they even decide
  // whether they want wake-word at all. The runtime behavior is
  // identical to a plain `import("@picovoice/porcupine-web")`.
  const specifier = ["@picovoice", "porcupine-web"].join("/");
  let PorcupineWorker: unknown;
  try {
    const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as {
      PorcupineWorker?: unknown;
    };
    PorcupineWorker = mod?.PorcupineWorker;
  } catch {
    return noop;
  }
  if (!PorcupineWorker) return noop;

  // At this point the app has the package and the key. Wire it up.
  // We accept `any` cast to keep TS happy without the types installed —
  // this is behind a dynamic gate so the bundle never includes it
  // unless the env is set.
  const WorkerCtor = PorcupineWorker as {
    create: (
      key: string,
      keyword:
        | { builtin: string; sensitivity?: number }
        | { publicPath: string; label: string; sensitivity?: number }
        | Array<
            | { builtin: string; sensitivity?: number }
            | { publicPath: string; label: string; sensitivity?: number }
          >,
      detectionCb: (detection: { label: string }) => void,
      model: { publicPath: string },
    ) => Promise<{ start: () => Promise<void>; release: () => Promise<void> }>;
  };

  // Default keyword: "computer" (built-in, free, no training). Swap to
  // the custom "Hey Lumo" model once it's trained.
  const keyword =
    opts.keyword ??
    ({ builtin: "computer" } as const);
  const keywordParam =
    "builtin" in keyword
      ? { builtin: keyword.builtin, sensitivity: 0.7 }
      : {
          publicPath: keyword.custom.publicPath,
          label: keyword.custom.label,
          sensitivity: 0.7,
        };

  try {
    const worker = await WorkerCtor.create(
      key,
      keywordParam,
      (detection) => {
        if (detection?.label) {
          try {
            opts.onWake();
          } catch (err) {
            console.warn("[wake-word] onWake threw:", err);
          }
        }
      },
      { publicPath: "/porcupine/porcupine_params.pv" },
    );
    await worker.start();
    return {
      active: true,
      stop: () => {
        try {
          void worker.release();
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    console.warn("[wake-word] Porcupine init failed:", err);
    return noop;
  }
}
