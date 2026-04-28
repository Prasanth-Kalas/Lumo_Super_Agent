"use client";

/**
 * /admin (Overview) — at-a-glance operator view.
 *
 * Three cards: queue depth (pending submissions), app counts by
 * lifecycle status, env health (Supabase / ElevenLabs / Anthropic
 * keys present). Click each card to drill into the relevant tab.
 *
 * Kept loose on data shape — different APIs, different errors,
 * fail-soft per card.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

interface Submission {
  status: "pending" | "certification_failed" | "approved" | "rejected" | "revoked";
}

export default function AdminOverviewPage() {
  const [queue, setQueue] = useState<Submission[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/review-queue", {
          cache: "no-store",
        });
        if (res.status === 403) {
          setErr(
            "You're signed in but not on the admin allowlist. Add your email to LUMO_ADMIN_EMAILS on Vercel.",
          );
          setQueue([]);
          return;
        }
        if (!res.ok) {
          setQueue([]);
          return;
        }
        const j = (await res.json()) as { submissions?: Submission[] };
        setQueue(j.submissions ?? []);
      } catch {
        setQueue([]);
      }
    })();
  }, []);

  const counts = {
    pending: queue?.filter((s) => s.status === "pending").length ?? 0,
    approved: queue?.filter((s) => s.status === "approved").length ?? 0,
    rejected: queue?.filter((s) => s.status === "rejected").length ?? 0,
    revoked: queue?.filter((s) => s.status === "revoked").length ?? 0,
    certification_failed:
      queue?.filter((s) => s.status === "certification_failed").length ?? 0,
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Overview</h1>
        <p className="text-[13px] text-lumo-fg-mid">
          Operator console — queue depth, app lifecycle, runtime knobs.
        </p>
      </div>

      {err ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
          {err}
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card
          href="/admin/review-queue"
          label="Review queue"
          value={counts.pending}
          hint={
            counts.pending === 0
              ? "Nothing waiting"
              : counts.pending === 1
                ? "1 submission needs review"
                : `${counts.pending} submissions need review`
          }
          tone={counts.pending > 0 ? "warn" : "ok"}
        />
        <Card
          href="/admin/apps"
          label="Approved apps"
          value={counts.approved}
          hint={`${counts.rejected + counts.revoked + counts.certification_failed} not active`}
          tone="ok"
        />
        <Card
          href="/admin/settings"
          label="Runtime settings"
          value={"→"}
          hint="LLM, voice, prompts, feature flags"
          tone="info"
        />
      </div>

      <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-2">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
          Quick links
        </div>
        <div className="flex flex-wrap gap-2 text-[12.5px]">
          <Link
            href="/admin/review-queue"
            className="text-lumo-accent hover:underline underline-offset-4"
          >
            Review submissions
          </Link>
          <span className="text-lumo-fg-low">·</span>
          <Link
            href="/admin/apps"
            className="text-lumo-accent hover:underline underline-offset-4"
          >
            Manage apps
          </Link>
          <span className="text-lumo-fg-low">·</span>
          <Link
            href="/admin/settings"
            className="text-lumo-accent hover:underline underline-offset-4"
          >
            Runtime settings
          </Link>
          <span className="text-lumo-fg-low">·</span>
          <Link
            href="/admin/health"
            className="text-lumo-accent hover:underline underline-offset-4"
          >
            Health
          </Link>
        </div>
      </div>
    </div>
  );
}

function Card({
  href,
  label,
  value,
  hint,
  tone,
}: {
  href: string;
  label: string;
  value: string | number;
  hint: string;
  tone: "ok" | "warn" | "info";
}) {
  const ring =
    tone === "warn"
      ? "ring-amber-500/40"
      : tone === "info"
        ? "ring-lumo-accent/40"
        : "ring-emerald-500/30";
  return (
    <Link
      href={href}
      className={
        "block rounded-xl border border-lumo-hair bg-lumo-surface p-4 hover:border-lumo-edge transition-colors ring-1 " +
        ring
      }
    >
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        {label}
      </div>
      <div className="mt-1 text-[28px] font-semibold tracking-tight text-lumo-fg num">
        {value}
      </div>
      <div className="text-[12px] text-lumo-fg-mid">{hint}</div>
    </Link>
  );
}
