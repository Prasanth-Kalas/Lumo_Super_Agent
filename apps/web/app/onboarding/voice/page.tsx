"use client";

/**
 * /onboarding/voice — first-time voice cloning consent + recording flow.
 *
 * Sealed posture (ADR-012):
 *   - Off by default. The user must arrive here deliberately.
 *   - This page is mandatory before any clone is created.
 *   - Three-stage flow: Disclosure → Recording → Confirmation. Cancelling
 *     at any stage purges partials and writes consent_revoked.
 *   - Self-hosted XTTS/Coqui is the v1 default engine. The page never
 *     surfaces the engine name during enrollment — that's an ops concern.
 *     The user's promise is "Lumo's self-hosted voice engine"; the
 *     particular implementation is exchangeable.
 *
 * Vegas-test posture: synthetic users only. The "Skip with synthetic
 * sample" path under `?synthetic=1` lets us demo the full happy path
 * without recording a real human voice. In production this query
 * param is gated by an env flag (Codex enforces); here we just render
 * a banner so the demo UI is honest about what it's doing.
 *
 * DPIA gate: when /api/voice/enrollment-policy returns
 * `awaitingLegalReview=true`, the consent card is read-only and
 * recording is locked. This is the kill-switch for production rollout
 * before external counsel signs off.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ConsentCard } from "@/components/voice/ConsentCard";
import { SampleRecorder } from "@/components/voice/SampleRecorder";
import { VoiceStatusBadge } from "@/components/voice/VoiceStatusBadge";

type Stage = "disclosure" | "recording" | "cloning" | "confirm" | "done";

const CONSENT_VERSION = "2026-04-27.v1";

export default function VoiceOnboardingPage() {
  return (
    <Suspense fallback={<Shell />}>
      <VoiceOnboardingFlow />
    </Suspense>
  );
}

function Shell() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <div className="mx-auto w-full max-w-2xl px-5 py-10">
        <div className="h-8 w-60 rounded bg-lumo-elevated animate-pulse" />
        <div className="mt-6 h-72 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
      </div>
    </main>
  );
}

function VoiceOnboardingFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/settings/voice";
  const isSynthetic = params.get("synthetic") === "1";

  const [stage, setStage] = useState<Stage>("disclosure");
  const [awaitingLegalReview, setAwaitingLegalReview] = useState<boolean | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Pull DPIA gating from the server. Defaults to "review pending"
  // until we have a definitive yes — fail-closed.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/voice/enrollment-policy", {
          cache: "no-store",
        });
        if (!alive) return;
        if (!res.ok) {
          setAwaitingLegalReview(true);
          return;
        }
        const j = (await res.json()) as { awaitingLegalReview?: boolean };
        setAwaitingLegalReview(j.awaitingLegalReview === true);
      } catch {
        if (alive) setAwaitingLegalReview(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ----- Codex VOICE-1 stubs -----
  async function writeConsentGranted(_payload: {
    consentVersion: string;
    acknowledgmentText: string;
  }): Promise<void> {
    /* TODO: Codex VOICE-1 — POST to /api/voice/consent. Server
     * computes consent_text_hash and writes consent_audit_log. */
  }

  async function writeConsentRevoked(_reason: string): Promise<void> {
    /* TODO: Codex VOICE-1 — POST /api/voice/consent/revoke when the
     * user cancels mid-flow before a clone is materialised. */
  }

  async function submitSamplesForCloning(
    _samples: { lineId: string; durationMs: number }[],
  ): Promise<{ previewUrl: string }> {
    /* TODO: Codex VOICE-1 — finalize uploads, call self-hosted XTTS
     * cloning endpoint, return a one-shot preview URL signed for
     * playback. */
    return { previewUrl: "" };
  }

  async function finalizeClone(): Promise<void> {
    /* TODO: Codex VOICE-1 — mark voice_clones.status='active',
     * trigger 24h sample purge cron registration. */
  }

  async function discardClone(): Promise<void> {
    /* TODO: Codex VOICE-1 — deletes the just-created clone via the
     * standard revocation path. The 7-day SLA still applies even
     * for "try again" deletions. */
  }
  // ----- end stubs -----

  const handleAcknowledge = useCallback(
    async (payload: { acknowledgmentText: string }) => {
      try {
        await writeConsentGranted({
          consentVersion: CONSENT_VERSION,
          acknowledgmentText: payload.acknowledgmentText,
        });
        setStage("recording");
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Couldn't record consent.",
        );
      }
    },
    [],
  );

  const handleCancelDisclosure = useCallback(() => {
    router.replace(next);
  }, [next, router]);

  const handleSamplesReady = useCallback(
    async (samples: { lineId: string; durationMs: number }[]) => {
      setStage("cloning");
      setError(null);
      try {
        const { previewUrl: url } = await submitSamplesForCloning(samples);
        setPreviewUrl(url || null);
        setStage("confirm");
      } catch (e) {
        setError(
          e instanceof Error
            ? `Cloning failed: ${e.message}`
            : "Cloning failed.",
        );
        setStage("recording");
      }
    },
    [],
  );

  const handleCancelRecording = useCallback(async () => {
    try {
      await writeConsentRevoked("user_cancelled_recording");
    } catch {
      /* best-effort */
    }
    router.replace(next);
  }, [next, router]);

  const handleConfirmClone = useCallback(async () => {
    try {
      await finalizeClone();
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't finalize clone.");
    }
  }, []);

  const handleTryAgain = useCallback(async () => {
    try {
      await discardClone();
    } catch {
      /* ignore */
    }
    setPreviewUrl(null);
    setStage("recording");
  }, []);

  if (awaitingLegalReview === null) return <Shell />;

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">
              Voice cloning
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] sm:text-[30px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
            Set up Lumo&apos;s voice clone
          </h1>
          <p className="text-[14px] text-lumo-fg-mid leading-relaxed">
            Lumo can read drafts, briefs, and confirmations back to you in
            your own voice — so the playback feels like a note you left
            yourself, not a stranger reading your mail. Setup takes about
            two minutes. You can delete the clone any time.
          </p>
        </div>

        <Stepper stage={stage} />

        {isSynthetic ? (
          <div className="rounded-md border border-lumo-accent/30 bg-lumo-accent/10 px-3 py-2 text-[12.5px] text-lumo-accent">
            Demo mode — using a synthetic voice sample. No real audio is
            captured on this run.
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500"
          >
            {error}
          </div>
        ) : null}

        {stage === "disclosure" ? (
          <ConsentCard
            consentVersion={CONSENT_VERSION}
            awaitingLegalReview={awaitingLegalReview}
            onAcknowledge={handleAcknowledge}
            onCancel={handleCancelDisclosure}
          />
        ) : null}

        {stage === "recording" ? (
          <SampleRecorder
            onSamplesReady={handleSamplesReady}
            onCancel={handleCancelRecording}
          />
        ) : null}

        {stage === "cloning" ? (
          <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-6 text-center space-y-3">
            <div className="mx-auto h-8 w-8 rounded-full border-2 border-lumo-hair border-t-lumo-accent animate-spin" />
            <p className="text-[14px] text-lumo-fg-high">
              Building your voice profile…
            </p>
            <p className="text-[12.5px] text-lumo-fg-mid">
              Self-hosted on Lumo&apos;s infrastructure. Usually 20–60
              seconds.
            </p>
          </div>
        ) : null}

        {stage === "confirm" ? (
          <ConfirmationCard
            previewUrl={previewUrl}
            onConfirm={handleConfirmClone}
            onTryAgain={handleTryAgain}
          />
        ) : null}

        {stage === "done" ? (
          <DoneCard nextHref={next} />
        ) : null}
      </div>
    </main>
  );
}

function Stepper({ stage }: { stage: Stage }) {
  const steps: { id: Stage; label: string }[] = [
    { id: "disclosure", label: "Read & authorize" },
    { id: "recording", label: "Record three sentences" },
    { id: "confirm", label: "Confirm playback" },
  ];
  const stageIndex =
    stage === "cloning"
      ? 1
      : stage === "done"
        ? 2
        : steps.findIndex((s) => s.id === stage);
  return (
    <ol className="flex items-center gap-2 text-[11.5px] text-lumo-fg-low">
      {steps.map((s, i) => {
        const isActive = i === stageIndex;
        const isDone = i < stageIndex || stage === "done";
        return (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={[
                "inline-flex items-center justify-center h-5 w-5 rounded-full border text-[10px] font-medium",
                isActive
                  ? "border-lumo-accent bg-lumo-accent text-lumo-accent-ink"
                  : isDone
                    ? "border-lumo-ok/40 bg-lumo-ok/10 text-lumo-ok"
                    : "border-lumo-hair bg-lumo-bg text-lumo-fg-low",
              ].join(" ")}
              aria-current={isActive ? "step" : undefined}
            >
              {isDone ? "✓" : i + 1}
            </span>
            <span
              className={
                isActive
                  ? "text-lumo-fg-high font-medium"
                  : "text-lumo-fg-low"
              }
            >
              {s.label}
            </span>
            {i < steps.length - 1 ? (
              <span aria-hidden="true" className="w-4 h-px bg-lumo-hair" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ConfirmationCard(props: {
  previewUrl: string | null;
  onConfirm: () => void;
  onTryAgain: () => void;
}) {
  const { previewUrl, onConfirm, onTryAgain } = props;
  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-5">
      <div className="space-y-2">
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-lumo-fg">
          Listen to your voice
        </h2>
        <p className="text-[13px] text-lumo-fg-mid leading-relaxed">
          This is what Lumo will sound like when reading your drafts and
          summaries. If something feels off — pace, pitch, accent — try
          again with a fresh recording.
        </p>
      </div>
      <div className="rounded-md border border-lumo-hair bg-lumo-bg/40 p-4">
        {previewUrl ? (
          <audio
            controls
            src={previewUrl}
            className="w-full"
            aria-label="Preview of your voice clone"
          />
        ) : (
          <p className="text-[12.5px] text-lumo-fg-low">
            Preview audio will play here. (Codex VOICE-1 wires up the
            signed playback URL.)
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onTryAgain}
          className="h-9 px-3.5 rounded-md text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors"
        >
          Sounds right — finalize
        </button>
      </div>
    </div>
  );
}

function DoneCard({ nextHref }: { nextHref: string }) {
  return (
    <div className="rounded-xl border border-lumo-ok/30 bg-lumo-ok/10 p-5 sm:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-lumo-ok" />
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-lumo-ok">
          Your voice is set up
        </h2>
      </div>
      <p className="text-[13.5px] text-lumo-fg-high leading-relaxed">
        Lumo will use your voice for drafted-reply read-back, brief
        summaries, and confirmations on supported screens. Your raw
        recordings will be deleted within 24 hours; only the encrypted
        voice profile remains. You can delete the clone any time from
        settings.
      </p>
      <VoiceStatusBadge
        cloneStatus="active"
        ttsEngine="self_hosted_xtts"
        showEngineCaption
      />
      <div className="flex items-center justify-end gap-2 pt-2">
        <Link
          href={nextHref}
          className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors inline-flex items-center"
        >
          Continue
        </Link>
      </div>
    </div>
  );
}
