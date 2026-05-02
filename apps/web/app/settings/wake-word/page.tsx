"use client";

/**
 * /settings/wake-word — toggle, mic indicator demo, sensitivity tuning.
 *
 * Layout:
 *   1. Toggle row — single switch to enable/disable. Off-by-default.
 *      Turning ON when the user has never been through the consent
 *      flow routes them to /onboarding/wake-word; we do not bypass
 *      the disclosure ever.
 *   2. Mic indicator preview — renders MicIndicator inline so the
 *      user can see what it looks like. The real fixed-position
 *      indicator is rendered by the app shell (Codex wires that into
 *      app/layout.tsx).
 *   3. Sensitivity slider (3 levels).
 *   4. Test harness — re-runs the same WakeWordTest from onboarding,
 *      handy for "did the FAR climb in this room?".
 *   5. Battery / pause behavior — informational, not interactive.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  MicIndicator,
  type MicPausedReason,
} from "@/components/wake-word/MicIndicator";
import { WakeWordTest } from "@/components/wake-word/WakeWordTest";

type Sensitivity = "low" | "medium" | "high";

interface WakeWordState {
  enabled: boolean;
  hasConsented: boolean;
  sensitivity: Sensitivity;
  paused: MicPausedReason | null;
  engine: "custom_cnn" | "porcupine" | "unknown";
}

const SENSITIVITY_LEVELS: { id: Sensitivity; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

export default function WakeWordSettingsPage() {
  const router = useRouter();
  const [state, setState] = useState<WakeWordState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ----- Codex WAKE-1 stubs -----
  async function fetchWakeWordState(): Promise<WakeWordState> {
    /* TODO: Codex WAKE-1 — GET /api/wake-word/state. Returns
     * enabled flag, last-consent flag, sensitivity, current pause
     * reason if any. */
    return {
      enabled: false,
      hasConsented: false,
      sensitivity: "medium",
      paused: null,
      engine: "custom_cnn",
    };
  }

  async function setEnabled(_enabled: boolean): Promise<void> {
    /* TODO: Codex WAKE-1 — POST /api/wake-word/toggle. Server writes
     * wake_word_enabled or wake_word_disabled audit row and starts/
     * stops the engine. */
  }

  async function setSensitivity(_s: Sensitivity): Promise<void> {
    /* TODO: Codex WAKE-1 — PATCH /api/wake-word/state. Hot-reloads
     * the engine threshold. */
  }
  // ----- end stubs -----

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await fetchWakeWordState();
      setState(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!state) return;
      // First-run gate: turning ON without prior consent routes to the
      // disclosure flow. We never silent-enable.
      if (next && !state.hasConsented) {
        router.push("/onboarding/wake-word?next=/settings/wake-word");
        return;
      }
      setSaving(true);
      try {
        await setEnabled(next);
        setState((s) => (s ? { ...s, enabled: next, paused: null } : s));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't update setting.");
      } finally {
        setSaving(false);
      }
    },
    [router, state],
  );

  const handleSensitivity = useCallback(
    async (next: Sensitivity) => {
      if (!state) return;
      setSaving(true);
      try {
        await setSensitivity(next);
        setState((s) => (s ? { ...s, sensitivity: next } : s));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't update setting.");
      } finally {
        setSaving(false);
      }
    },
    [state],
  );

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">
              Settings · Hey Lumo
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
            Hey Lumo wake word
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed max-w-2xl">
            On-device wake-word detection. Audio stays on your device
            until the wake word fires locally. You can turn it on or
            off at any time.
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

        {/* Toggle */}
        <section
          aria-labelledby="ww-toggle-title"
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2
                id="ww-toggle-title"
                className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
              >
                Listening
              </h2>
              <p className="mt-0.5 text-[12.5px] text-lumo-fg-mid">
                {loading
                  ? "Loading…"
                  : state?.enabled
                    ? "Lumo is listening for the wake word."
                    : "Off. Lumo is not using your microphone."}
              </p>
              {state?.engine && state.enabled ? (
                <p className="mt-1 text-[11.5px] text-lumo-fg-low">
                  Engine: {state.engine === "custom_cnn" ? "on-device CNN" : state.engine}
                </p>
              ) : null}
            </div>
            <Toggle
              checked={state?.enabled === true}
              disabled={loading || saving}
              onChange={handleToggle}
              ariaLabel="Enable Hey Lumo wake-word listening"
            />
          </div>
        </section>

        {/* Mic indicator preview */}
        <section
          aria-labelledby="ww-indicator-title"
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3"
        >
          <h2
            id="ww-indicator-title"
            className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
          >
            Mic indicator
          </h2>
          <p className="text-[12.5px] text-lumo-fg-mid leading-relaxed">
            When listening is on, this indicator appears in the top-right
            corner of every Lumo screen. Click it to stop instantly. The
            indicator is non-dismissable while the mic is open.
          </p>
          <div className="rounded-md border border-lumo-hair bg-lumo-bg/40 p-4 flex items-center justify-center min-h-[60px]">
            {state?.enabled ? (
              <MicIndicator
                active
                paused={state.paused ?? null}
                position="inline"
                onClickStop={() => void handleToggle(false)}
              />
            ) : (
              <span className="text-[12.5px] text-lumo-fg-low">
                Indicator hidden — listening is off.
              </span>
            )}
          </div>
        </section>

        {/* Sensitivity */}
        <section
          aria-labelledby="ww-sens-title"
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3"
        >
          <h2
            id="ww-sens-title"
            className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
          >
            Sensitivity
          </h2>
          <p className="text-[12.5px] text-lumo-fg-mid leading-relaxed">
            Higher sensitivity catches softer voices but may trigger on
            similar phrases. Lower is stricter; better for noisy rooms.
          </p>
          <div
            role="radiogroup"
            aria-labelledby="ww-sens-title"
            className="inline-flex rounded-md border border-lumo-hair overflow-hidden"
          >
            {SENSITIVITY_LEVELS.map((s) => {
              const checked = state?.sensitivity === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => void handleSensitivity(s.id)}
                  disabled={loading || saving}
                  className={[
                    "h-9 px-4 text-[12.5px] transition-colors border-r border-lumo-hair last:border-r-0 disabled:opacity-50",
                    checked
                      ? "bg-lumo-fg text-lumo-bg"
                      : "bg-lumo-bg/40 text-lumo-fg-high hover:bg-lumo-elevated",
                  ].join(" ")}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* Test harness */}
        <WakeWordTest
          sensitivity={state?.sensitivity ?? "medium"}
          disabled={!state?.hasConsented}
        />

        {/* Battery and pause behavior */}
        <section
          aria-labelledby="ww-battery-title"
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3"
        >
          <h2
            id="ww-battery-title"
            className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
          >
            Battery and auto-pause
          </h2>
          <ul className="space-y-2 text-[12.5px] text-lumo-fg-high leading-relaxed">
            <Bullet>Idle for 30 minutes — listening pauses. Bring this tab to the front to resume.</Bullet>
            <Bullet>Tab in background for 5+ minutes — listening pauses to save power.</Bullet>
            <Bullet>Battery below 20% (mobile) — listening pauses automatically.</Bullet>
            <Bullet>Another app captures your mic — listening pauses, then resumes when the mic is free.</Bullet>
          </ul>
        </section>

        <p className="text-[11.5px] text-lumo-fg-low text-center pt-2">
          Wake word governance follows{" "}
          <Link
            href="/legal/privacy#wake-word"
            className="underline decoration-lumo-fg-low underline-offset-2 hover:text-lumo-fg-mid"
          >
            ADR-010
          </Link>
          .
        </p>
      </div>
    </main>
  );
}

function Toggle(props: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  const { checked, disabled = false, onChange, ariaLabel } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-lumo-accent focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-lumo-accent" : "bg-lumo-elevated border border-lumo-hair",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        ].join(" ")}
      />
    </button>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-lumo-fg-low flex-shrink-0"
      />
      <span>{children}</span>
    </li>
  );
}
