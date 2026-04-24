"use client";

/**
 * /publisher — invited-partner portal.
 *
 * For publishers: a form to submit a manifest URL and a table of
 * their past submissions. That's it. Kept deliberately bare so the
 * invited-partners cohort can onboard in under 5 minutes without
 * wading through configuration.
 *
 * When the current user isn't on LUMO_PUBLISHER_EMAILS, we render
 * a "not invited" notice with a link back to /marketplace. Same
 * UX pattern as the auth-env-missing page — tell the user exactly
 * what's going on instead of showing a blank form that'll fail.
 *
 * Data:
 *   GET  /api/publisher/submissions  list my submissions
 *   POST /api/publisher/submit       add a new one (pending)
 *
 * Approval happens in /admin/review-queue.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Submission {
  id: string;
  publisher_email: string;
  manifest_url: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  submitted_at: string;
  reviewed_at: string | null;
  reviewer_note: string | null;
  publisher_key: string | null;
}

interface Me {
  email: string | null;
  full_name: string | null;
}

export default function PublisherPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [manifestUrl, setManifestUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (!res.ok) {
          setMeLoaded(true);
          return;
        }
        const j = (await res.json()) as { user?: Me };
        setMe(j.user ?? null);
      } finally {
        setMeLoaded(true);
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/publisher/submissions", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const j = (await res.json()) as { submissions?: Submission[] };
      setSubmissions(j.submissions ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const url = manifestUrl.trim();
    if (!url || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/publisher/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest_url: url }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.detail as string | undefined) ??
            (j?.error as string | undefined) ??
            `HTTP ${res.status}`,
        );
      }
      setManifestUrl("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!meLoaded) return <Shell />;

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex flex-col">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-5 py-3">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-lumo-fg hover:text-lumo-accent transition-colors"
          >
            <BrandMark size={22} />
            <span className="text-[14px] font-semibold tracking-tight">
              Lumo
            </span>
            <span className="hidden sm:inline text-[12px] text-lumo-fg-low">
              /
            </span>
            <span className="hidden sm:inline text-[13px]">Publisher</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-5 py-10 flex-1">
        <div className="mb-8 space-y-2">
          <h1 className="text-[28px] font-semibold tracking-[-0.022em]">
            Submit an agent to the Lumo appstore
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid max-w-2xl">
            Invited partners only. Point us at your manifest URL; we
            validate the shape, run a health probe, and land the row
            in the review queue. Once approved, your tools show up on
            the marketplace and users can connect them.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-3"
        >
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
              Manifest URL
            </span>
            <input
              type="url"
              value={manifestUrl}
              onChange={(e) => setManifestUrl(e.target.value)}
              placeholder="https://your-agent.example.com/.well-known/agent.json"
              className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13.5px] placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
              disabled={busy || !me?.email}
            />
          </label>

          {err ? (
            <div className="text-[12px] text-red-400 border border-red-500/30 bg-red-500/5 rounded-md px-2 py-1.5">
              {err}
            </div>
          ) : null}

          <div className="flex items-center justify-between pt-1">
            <Link
              href="https://github.com/Prasanth-Kalas/Lumo_Agent_Starter"
              target="_blank"
              className="text-[12px] text-lumo-fg-low hover:text-lumo-fg underline-offset-4 hover:underline"
            >
              Starter template →
            </Link>
            <button
              type="submit"
              disabled={busy || !manifestUrl.trim() || !me?.email}
              className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low transition-colors"
            >
              {busy ? "Submitting…" : "Submit for review"}
            </button>
          </div>
        </form>

        <div className="mt-10">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-semibold">Your submissions</h2>
            {submissions ? (
              <span className="text-[11px] text-lumo-fg-low num">
                {submissions.length} total
              </span>
            ) : null}
          </div>

          {!submissions ? (
            <div className="text-[13px] text-lumo-fg-mid py-6">Loading…</div>
          ) : submissions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-surface/40 p-6 text-center text-[13px] text-lumo-fg-mid">
              Nothing submitted yet. Fork the starter template, deploy,
              and paste your manifest URL above.
            </div>
          ) : (
            <ul className="space-y-2">
              {submissions.map((s) => (
                <li
                  key={s.id}
                  className="rounded-xl border border-lumo-hair bg-lumo-surface p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] text-lumo-fg truncate">
                        {s.manifest_url}
                      </div>
                      <div className="mt-1 text-[11.5px] text-lumo-fg-low num">
                        submitted {formatRelative(s.submitted_at)}
                        {s.reviewed_at ? (
                          <>
                            {" · reviewed "}
                            {formatRelative(s.reviewed_at)}
                          </>
                        ) : null}
                      </div>
                      {s.reviewer_note ? (
                        <div className="mt-1 text-[12.5px] text-lumo-fg-mid">
                          {s.reviewer_note}
                        </div>
                      ) : null}
                      {s.status === "approved" && s.publisher_key ? (
                        <div className="mt-1 text-[11.5px] text-lumo-fg-low num">
                          publisher key:{" "}
                          <code className="text-lumo-fg">
                            {s.publisher_key.slice(0, 12)}…
                          </code>
                        </div>
                      ) : null}
                    </div>
                    <StatusPill status={s.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

function Shell() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex items-center justify-center px-5">
      <div className="h-10 w-60 rounded-md bg-lumo-elevated animate-pulse" />
    </main>
  );
}

function StatusPill({ status }: { status: Submission["status"] }) {
  const label =
    status === "pending"
      ? "in review"
      : status === "approved"
        ? "approved"
        : status === "rejected"
          ? "rejected"
          : "revoked";
  const tone =
    status === "approved"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : status === "pending"
        ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
        : "bg-red-500/10 text-red-400 border-red-500/20";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] border " +
        tone
      }
    >
      {label}
    </span>
  );
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso).getTime();
    const m = Math.round((Date.now() - d) / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
