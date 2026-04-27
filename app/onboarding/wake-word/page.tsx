"use client";

/**
 * /onboarding/wake-word — wake-word opt-in with privacy explainer.
 *
 * Per ADR-010 §6 the first-run consent flow has three required parts:
 *   1. Privacy invariant in plain language ("Audio stays on your device
 *      until you say 'Hey Lumo'.").
 *   2. A short test capture so the user verifies the mic works AND the
 *      detector hears them.
 *   3. A single "I understand" action that writes the audit row and
 *      activates the engine.
 *
 * Sealed posture (ADR-010):
 *   - Off by default. The user lands here only by deliberate action.
 *   - Custom on-device CNN is the v1 production path; Picovoice is a
 *     paid fallback. The page does not expose a model picker — that's
 *     an ops concern.
 *   - No silent enable. The audit row is written *before* we flip the
 *     engine into production listening mode (writeWakeWordEnabled is
 *     called by handleEnable below).
 *
 * Independence from voice cloning: ADR-010 §11 Q4 states wake-word is
 * independent of voice cloning. A user can enable wake-word without
 * ever enrolling a clone, and vice versa.
 */

import { Suspense, useCallback, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WakeWordTest } from "@/components/wake-word/WakeWordTest";

const SENSITIVITY_LEVELS = [
  {
    id: "low",
    label: "Low",
    blurb: "Stricter. Fewer accidental triggers in noisy rooms.",
  },
  {
    id: "medium",
    label: "Medium",
    blurb: "Balanced. Recommended for most rooms and most voices.",
  },
  {
    id: "high",
    label: "High",
    blurb: "Looser. Picks up softer voices but may trigger on similar phrases.",
  },
] as const;

type Sensitivity = (typeof SENSITIVITY_LEVELS)[number]["id"];

export default function WakeWordOnboardingPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
          <div className="mx-auto w-full max-w-2xl px-5 py-10">
            <div className="h-8 w-60 rounded bg-lumo-elevated animate-pulse" />
            <div className="mt-6 h-72 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
          </div>
        </main>
      }
    >
      <WakeWordOnboardingFlow />
    </Suspense>
  );
}

function WakeWordOnboardingFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/settings/wake-word";

  const [sensitivity, setSensitivity] = useState<Sensitivity>("medium");
  const [understood, setUnderstood] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ----- Codex WAKE-1 stubs -----
  async function writeWakeWordEnabled(_opts: {
    sensitivity: Sensitivity;
  }): Promise<void> {
    /* TODO: Codex WAKE-1 — POST /api/wake-word/enable. Server writes
     * consent_audit_log row with action='wake_word_enabled' and
     * stores the sensitivity. */
  }

  async function startEngine(_opts: { sensitivity: Sensitivity }): Promise<void> {
    /* TODO: Codex WAKE-1 — call lib/wake-word/engine.ts start() with
     * the user's sensitivity. */
  }
  // ----- end stubs -----

  const handleEnable = useCallback(async () => {
    if (!understood) return;
    setEnabling(true);
    setError(null);
    try {
      await writeWakeWordEnabled({ sensitivity });
      await startEngine({ sensitivity });
      router.replace(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't enable wake word.");
      setEnabling(false);
    }
  }, [next, router, sensitivity, understood]);

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={20} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">
              Hey Lumo
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] sm:text-[30px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
            Turn on &quot;Hey Lumo&quot;
          </h1>
          <p className="text-[14px] text-lumo-fg-mid leading-relaxed">
            Hands-free wake word — say &quot;Hey Lumo&quot; and Lumo
            starts listening. The detector runs entirely on your device.
            No audio leaves your device until the wake word fires
            locally.
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

        {/* Privacy invariants — plain English. */}
        <section
          aria-labelledby="ww-privacy-title"
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4"
        >
          <div className="space-y-1">
            <h2
              id="ww-privacy-title"
              className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
            >
              How Lumo handles your microphone
            </h2>
            <p className="text-[12.5px] text-lumo-fg-mid">
              Read these before turning the feature on.
            </p>
          </div>
          <ul className="space-y-2.5 text-[13px] text-lumo-fg-high leading-relaxed">
            <Bullet>
              <strong>Local listening only.</strong> Until you say
              &quot;Hey Lumo,&quot; nothing your mic hears leaves your
              device. The detector matches the wake word right in your
              browser.
            </Bullet>
            <Bullet>
              <strong>You&apos;ll always see the mic indicator.</strong>{" "}
              Whenever Lumo is listening, a badge in the top-right
              corner of the screen shows &quot;Listening for &apos;Hey
              Lumo&apos;.&quot; You can click it to stop instantly.
            </Bullet>
            <Bullet>
              <strong>Auto-pauses to save battery.</strong> Lumo stops
              listening after 30 minutes of inactivity, when your battery
              drops below 20%, or when this tab has been in the
              background for more than 5 minutes. Bring the tab back to
              resume.
            </Bullet>
            <Bullet>
              <strong>Off in one click.</strong> Disable any time in
              settings. Disabling stops the mic immediately and writes
              an entry to your audit log.
            </Bullet>
            <Bullet>
              <strong>Independent of voice cloning.</strong> Wake word
              doesn&apos;t use, share, or train on your voice profile.
              You can use one without the other.
            </Bullet>
          </ul>
        </section>

        {/* Test capture — gives the user confidence before they commit. */}
        <WakeWordTest sensitivity={sensitivity} />

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
          <p className="text-[12.5px] text-lumo-fg-mid">
            Pick the level that worked best in the test above. You can
            change it in settings.
          </p>
          <fieldset className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <legend className="sr-only">Wake-word sensitivity level</legend>
            {SENSITIVITY_LEVELS.map((s) => {
              const id = `sens-${s.id}`;
              const checked = sensitivity === s.id;
              return (
                <label
                  key={s.id}
                  htmlFor={id}
                  className={[
                    "flex flex-col gap-1 rounded-md border p-3 cursor-pointer transition-colors",
                    checked
                      ? "border-lumo-accent bg-lumo-accent/5"
                      : "border-lumo-hair bg-lumo-bg/40 hover:border-lumo-fg-low/40",
                  ].join(" ")}
                >
                  <input
                    id={id}
                    type="radio"
                    name="sensitivity"
                    value={s.id}
                    checked={checked}
                    onChange={() => setSensitivity(s.id)}
                    className="sr-only"
                  />
                  <span className="flex items-center gap-2 text-[13px] font-medium text-lumo-fg">
                    <span
                      aria-hidden="true"
                      className={[
                        "inline-block h-3 w-3 rounded-full border-2",
                        checked
                          ? "border-lumo-accent bg-lumo-accent"
                          : "border-lumo-fg-low",
                      ].join(" ")}
                    />
                    {s.label}
                  </span>
                  <span className="text-[12px] text-lumo-fg-mid leading-snug">
                    {s.blurb}
                  </span>
                </label>
              );
            })}
          </fieldset>
        </section>

        {/* Final acknowledgment + enable */}
        <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4">
          <label
            htmlFor="ww-understood"
            className="flex items-start gap-3 cursor-pointer"
          >
            <input
              id="ww-understood"
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-lumo-hair bg-lumo-bg text-lumo-accent focus:ring-2 focus:ring-lumo-accent"
            />
            <span className="text-[13px] text-lumo-fg-high leading-relaxed">
              I understand: my mic stays open while Lumo is listening,
              the indicator will be visible the whole time, and I can
              turn this off in one click.
            </span>
          </label>
          <div className="flex items-center justify-end gap-2">
            <Link
              href={next}
              className="h-9 px-3.5 rounded-md text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors inline-flex items-center"
            >
              Not now
            </Link>
            <button
              type="button"
              onClick={() => void handleEnable()}
              disabled={!understood || enabling}
              aria-disabled={!understood || enabling}
              className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {enabling ? "Turning on…" : "Turn on Hey Lumo"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-lumo-accent flex-shrink-0"
      />
      <span>{children}</span>
    </li>
  );
}
