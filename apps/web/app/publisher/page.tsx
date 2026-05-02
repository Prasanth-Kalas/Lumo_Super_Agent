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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  buildDeveloperLaunchSteps,
  developerLaunchStatusLabel,
  developerPlatformStats,
  developerPlatformSummary,
  type DeveloperLaunchStep,
} from "@/lib/developer-platform-ui";

interface Submission {
  id: string;
  publisher_email: string;
  manifest_url: string;
  version: string;
  is_published: boolean;
  logo_url: string | null;
  status: "pending" | "certification_failed" | "approved" | "rejected" | "revoked";
  certification_status: "passed" | "needs_review" | "failed" | null;
  certification_report: CertificationReport | null;
  certified_at: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewer_note: string | null;
  publisher_key: string | null;
}

interface DeveloperAccount {
  email: string;
  display_name: string | null;
  company: string | null;
  reason: string | null;
  tier: "waitlisted" | "approved" | "rejected" | "revoked";
  source?: "env_allowlist" | "db";
  reviewer_note?: string | null;
  created_at?: string | null;
}

interface CertificationReport {
  checked_at: string;
  status: "passed" | "needs_review" | "failed";
  summary: Record<"blocker" | "high" | "medium" | "low" | "info", number>;
  findings: Array<{
    severity: "blocker" | "high" | "medium" | "low" | "info";
    code: string;
    message: string;
    evidence?: string;
  }>;
  tools: Array<{ name: string; cost_tier: string }>;
}

interface Me {
  email: string | null;
  full_name: string | null;
}

export default function PublisherPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [developer, setDeveloper] = useState<DeveloperAccount | null>(null);
  const [developerLoaded, setDeveloperLoaded] = useState(false);
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [manifestUrl, setManifestUrl] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [certifying, setCertifying] = useState(false);
  const [preflight, setPreflight] = useState<CertificationReport | null>(null);
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

  const refreshDeveloper = useCallback(async () => {
    try {
      const res = await fetch("/api/partners/me", { cache: "no-store" });
      if (!res.ok) {
        setDeveloper(null);
        return;
      }
      const j = (await res.json()) as { developer?: DeveloperAccount | null };
      setDeveloper(j.developer ?? null);
    } catch {
      setDeveloper(null);
    } finally {
      setDeveloperLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (me?.email) void refreshDeveloper();
    else if (meLoaded) setDeveloperLoaded(true);
  }, [me?.email, meLoaded, refreshDeveloper]);

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

  const launchSteps = useMemo(
    () =>
      buildDeveloperLaunchSteps({
        submissions: submissions ?? [],
        manifestUrl,
        preflight,
      }),
    [manifestUrl, preflight, submissions],
  );
  const platformStats = useMemo(
    () => developerPlatformStats(submissions ?? []),
    [submissions],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const url = manifestUrl.trim();
    if (!url || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const trimmedLogo = logoUrl.trim();
      const res = await fetch("/api/publisher/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest_url: url,
          // Only attach logo_url when the field has content. Empty
          // string would clear an existing logo on resubmit; we
          // don't want to silently clear here unless the user
          // explicitly typed nothing — see the resubmit path's
          // dedicated logo editor below.
          ...(trimmedLogo && { logo_url: trimmedLogo }),
        }),
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
      setLogoUrl("");
      setPreflight(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function certify() {
    const url = manifestUrl.trim();
    if (!url || certifying) return;
    setCertifying(true);
    setErr(null);
    setPreflight(null);
    try {
      const res = await fetch("/api/publisher/certify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest_url: url }),
      });
      const j = (await res.json().catch(() => null)) as
        | { certification?: CertificationReport; error?: string; detail?: string }
        | null;
      if (!res.ok) {
        throw new Error(j?.detail ?? j?.error ?? `HTTP ${res.status}`);
      }
      setPreflight(j?.certification ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCertifying(false);
    }
  }

  if (!meLoaded || (me?.email && !developerLoaded)) return <Shell />;

  // Render decision tree:
  //   1. Not signed in → "Sign in to apply" landing.
  //   2. Signed in, no developer row, not on env allowlist → signup form.
  //   3. Signed in, tier waitlisted → waitlist message.
  //   4. Signed in, tier rejected → rejection with re-apply button.
  //   5. Signed in, tier revoked → revoked notice (no re-apply path).
  //   6. Signed in, tier approved (env or DB) → existing dashboard.
  const isApproved = developer?.tier === "approved";

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex flex-col">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-5 py-3">
          <Link
            href="/"
            className="flex items-center gap-2.5 hover:opacity-90 transition-opacity"
          >
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-[12px] text-lumo-fg-low">
              /
            </span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">
              Developer portal
            </span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-5 py-10 flex-1">
        {!me?.email ? (
          <NotSignedInPanel />
        ) : !isApproved ? (
          <DeveloperGatePanel
            developer={developer}
            onApplied={() => void refreshDeveloper()}
          />
        ) : (
          <>
            <div className="mb-8 space-y-2">
              <h1 className="text-[28px] font-semibold tracking-[-0.022em]">
                Submit an agent to the Lumo appstore
              </h1>
              <p className="text-[13.5px] text-lumo-fg-mid max-w-2xl">
                Point us at your manifest URL; we validate the shape, run a
                health probe, and land the row in the review queue. Once
                approved, your tools show up on the marketplace and users
                can connect them.
              </p>
            </div>

        <DeveloperLaunchpad
          steps={launchSteps}
          stats={platformStats}
          summary={developerPlatformSummary(submissions ?? [])}
        />

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

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
              Logo URL <span className="text-lumo-fg-low normal-case">(optional)</span>
            </span>
            <div className="mt-1 flex items-center gap-3">
              <LogoPreview src={logoUrl.trim()} alt="logo preview" />
              <input
                type="url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://cdn.example.com/your-agent-icon.png"
                className="flex-1 rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13.5px] placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
                disabled={busy || !me?.email}
              />
            </div>
            <span className="mt-1 block text-[11px] text-lumo-fg-low">
              Square PNG/SVG hosted on your CDN. Falls back to an
              auto-generated avatar when blank.
            </span>
          </label>

          {err ? (
            <div className="text-[12px] text-red-400 border border-red-500/30 bg-red-500/5 rounded-md px-2 py-1.5">
              {err}
            </div>
          ) : null}

          <CertificationPanel report={preflight} />

          <div className="flex items-center justify-between pt-1">
            <Link
              href="https://github.com/Prasanth-Kalas/Lumo_Agent_Starter"
              target="_blank"
              className="text-[12px] text-lumo-fg-low hover:text-lumo-fg underline-offset-4 hover:underline"
            >
              Starter template →
            </Link>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void certify()}
                disabled={certifying || busy || !manifestUrl.trim() || !me?.email}
                className="h-8 px-3 rounded-md border border-lumo-hair text-lumo-fg-mid text-[12.5px] hover:bg-lumo-elevated hover:text-lumo-fg disabled:opacity-50 transition-colors"
              >
                {certifying ? "Checking…" : "Run checks"}
              </button>
              <button
                type="submit"
                disabled={busy || !manifestUrl.trim() || !me?.email}
                className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low transition-colors"
              >
                {busy ? "Submitting…" : "Submit for review"}
              </button>
            </div>
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
                    <LogoPreview src={s.logo_url} alt="agent logo" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13.5px] text-lumo-fg">
                        <span className="truncate">{s.manifest_url}</span>
                        <span className="text-[11px] text-lumo-fg-low num shrink-0">
                          v{s.version}
                        </span>
                        {s.is_published ? (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
                            Live
                          </span>
                        ) : null}
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
                      <CertificationPanel report={s.certification_report} />
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
          </>
        )}
      </div>
    </main>
  );
}

function DeveloperLaunchpad({
  steps,
  stats,
  summary,
}: {
  steps: DeveloperLaunchStep[];
  stats: ReturnType<typeof developerPlatformStats>;
  summary: string;
}) {
  return (
    <section className="mb-8 rounded-xl border border-lumo-hair bg-lumo-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold">Developer launchpad</h2>
          <p className="mt-1 text-[12.5px] text-lumo-fg-mid">{summary}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right">
          <Metric label="Live" value={stats.approved} />
          <Metric label="Review" value={stats.inReview} />
          <Metric label="Blocked" value={stats.blocked} />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-2.5">
        {steps.map((step) => (
          <div
            key={step.id}
            className="rounded-lg border border-lumo-hair bg-lumo-bg/45 p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-[12.5px] font-semibold text-lumo-fg">
                {step.title}
              </h3>
              <span
                className={
                  "shrink-0 rounded-full border px-2 py-0.5 text-[9.5px] uppercase tracking-[0.13em] " +
                  launchStepTone(step.status)
                }
              >
                {developerLaunchStatusLabel(step.status)}
              </span>
            </div>
            <p className="mt-2 text-[11.5px] leading-5 text-lumo-fg-mid">
              {step.detail}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-16 rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2">
      <div className="text-[15px] font-semibold num">{value}</div>
      <div className="text-[10px] uppercase tracking-[0.13em] text-lumo-fg-low">
        {label}
      </div>
    </div>
  );
}

function launchStepTone(status: DeveloperLaunchStep["status"]): string {
  switch (status) {
    case "done":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-400";
    case "active":
      return "border-sky-500/25 bg-sky-500/10 text-sky-400";
    case "blocked":
      return "border-red-500/25 bg-red-500/10 text-red-400";
    case "idle":
      return "border-lumo-hair bg-lumo-elevated text-lumo-fg-low";
  }
}

function Shell() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex items-center justify-center px-5">
      <div className="h-10 w-60 rounded-md bg-lumo-elevated animate-pulse" />
    </main>
  );
}

function NotSignedInPanel() {
  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-8 text-center">
      <h1 className="text-[22px] font-semibold tracking-[-0.018em]">
        Sign in to apply as a Lumo developer
      </h1>
      <p className="mt-2 text-[13px] text-lumo-fg-mid max-w-md mx-auto">
        The developer portal lets you submit agents to the Lumo
        marketplace, manage versions, and track approvals. Sign in to
        get started.
      </p>
      <Link
        href="/auth/login?next=/publisher"
        className="inline-flex mt-5 h-9 items-center px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink"
      >
        Sign in
      </Link>
    </div>
  );
}

function DeveloperGatePanel({
  developer,
  onApplied,
}: {
  developer: DeveloperAccount | null;
  onApplied: () => void;
}) {
  const [displayName, setDisplayName] = useState(developer?.display_name ?? "");
  const [company, setCompany] = useState(developer?.company ?? "");
  const [reason, setReason] = useState(developer?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed inputs when the developer row hydrates (initial GET) so
  // re-applications after rejection show the prior application text
  // rather than blanking the form.
  useEffect(() => {
    if (developer) {
      setDisplayName(developer.display_name ?? "");
      setCompany(developer.company ?? "");
      setReason(developer.reason ?? "");
    }
  }, [developer]);

  // Existing application states — render their own surface, no form.
  if (developer && developer.tier === "waitlisted") {
    return (
      <GateNotice
        title="Application received"
        tone="amber"
        body={
          <>
            Thanks — your application is in review. We'll email{" "}
            <code className="text-lumo-fg">{developer.email}</code> when
            an admin acts on it. Most decisions land within a few
            business days.
          </>
        }
      />
    );
  }
  if (developer && developer.tier === "rejected") {
    return (
      <div className="space-y-4">
        <GateNotice
          title="Application not approved"
          tone="red"
          body={
            <>
              {developer.reviewer_note ? (
                <>
                  <span className="block text-lumo-fg">Reviewer note:</span>
                  <span className="block mt-1">{developer.reviewer_note}</span>
                </>
              ) : (
                <>The Lumo team didn't approve this application.</>
              )}
              <span className="block mt-2 text-[12px]">
                Update the form below and resubmit when you've addressed the
                concerns.
              </span>
            </>
          }
        />
        <ApplicationForm
          displayName={displayName}
          setDisplayName={setDisplayName}
          company={company}
          setCompany={setCompany}
          reason={reason}
          setReason={setReason}
          busy={busy}
          err={err}
          onSubmit={submit}
          ctaLabel="Re-apply"
        />
      </div>
    );
  }
  if (developer && developer.tier === "revoked") {
    return (
      <GateNotice
        title="Developer access revoked"
        tone="red"
        body={
          <>
            Your account is no longer active on the Lumo marketplace.
            Contact the Lumo team if you'd like to discuss
            reinstatement.
          </>
        }
      />
    );
  }

  // No row → first-time signup form.
  return (
    <ApplicationForm
      displayName={displayName}
      setDisplayName={setDisplayName}
      company={company}
      setCompany={setCompany}
      reason={reason}
      setReason={setReason}
      busy={busy}
      err={err}
      onSubmit={submit}
      ctaLabel="Apply to publish"
      heading="Apply to publish on Lumo"
      sub="Tell us a bit about you. Approved developers can submit agents and ship updates."
    />
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/partners/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          display_name: displayName.trim() || undefined,
          company: company.trim() || undefined,
          reason: reason.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.detail as string | undefined) ??
            (j?.error as string | undefined) ??
            `HTTP ${res.status}`,
        );
      }
      onApplied();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
}

function ApplicationForm({
  displayName,
  setDisplayName,
  company,
  setCompany,
  reason,
  setReason,
  busy,
  err,
  onSubmit,
  ctaLabel,
  heading,
  sub,
}: {
  displayName: string;
  setDisplayName: (v: string) => void;
  company: string;
  setCompany: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  err: string | null;
  onSubmit: (e: React.FormEvent) => void;
  ctaLabel: string;
  heading?: string;
  sub?: string;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-3"
    >
      {heading ? (
        <div className="space-y-1">
          <h1 className="text-[22px] font-semibold tracking-[-0.018em]">
            {heading}
          </h1>
          {sub ? (
            <p className="text-[13px] text-lumo-fg-mid">{sub}</p>
          ) : null}
        </div>
      ) : null}

      <label className="block">
        <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
          Your name
        </span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Alex Rivera"
          className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13.5px] placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
          disabled={busy}
        />
      </label>

      <label className="block">
        <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
          Company
        </span>
        <input
          type="text"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="DoorDash"
          className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13.5px] placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
          disabled={busy}
        />
      </label>

      <label className="block">
        <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
          What are you building?
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Briefly: what your agent does and which users would benefit."
          rows={3}
          className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13.5px] placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none resize-y"
          disabled={busy}
        />
      </label>

      {err ? (
        <div className="text-[12px] text-red-400 border border-red-500/30 bg-red-500/5 rounded-md px-2 py-1.5">
          {err}
        </div>
      ) : null}

      <div className="flex items-center justify-end pt-1">
        <button
          type="submit"
          disabled={busy}
          className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low transition-colors"
        >
          {busy ? "Sending…" : ctaLabel}
        </button>
      </div>
    </form>
  );
}

function GateNotice({
  title,
  body,
  tone,
}: {
  title: string;
  body: React.ReactNode;
  tone: "amber" | "red" | "emerald";
}) {
  const palette =
    tone === "amber"
      ? "border-amber-500/30 bg-amber-500/5 text-amber-300"
      : tone === "red"
        ? "border-red-500/30 bg-red-500/5 text-red-300"
        : "border-emerald-500/30 bg-emerald-500/5 text-emerald-300";
  return (
    <div className={`rounded-xl border p-6 ${palette}`}>
      <h2 className="text-[16px] font-semibold text-lumo-fg">{title}</h2>
      <div className="mt-2 text-[13px] text-lumo-fg-mid">{body}</div>
    </div>
  );
}

function LogoPreview({
  src,
  alt,
}: {
  src: string | null | undefined;
  alt: string;
}) {
  const trimmed = src && src.trim() ? src.trim() : null;
  // Fixed 40px square mirroring the marketplace card icon size.
  // Falls back to a neutral placeholder so an empty value doesn't
  // collapse the row's grid alignment.
  if (!trimmed) {
    return (
      <div
        aria-hidden="true"
        className="shrink-0 w-10 h-10 rounded-md border border-dashed border-lumo-hair bg-lumo-bg/50 grid place-items-center text-[10px] uppercase tracking-[0.12em] text-lumo-fg-low"
      >
        no logo
      </div>
    );
  }
  return (
    <img
      src={trimmed}
      alt={alt}
      width={40}
      height={40}
      className="shrink-0 w-10 h-10 rounded-md object-cover border border-lumo-hair bg-lumo-bg"
      onError={(e) => {
        // Bad URL → swap for a placeholder rather than show a broken
        // image icon. We don't try to be clever about why (404, CORS,
        // mime); the developer can see the raw URL in the input field
        // alongside this preview.
        const t = e.currentTarget;
        t.style.display = "none";
      }}
    />
  );
}

function StatusPill({ status }: { status: Submission["status"] }) {
  const label =
    status === "pending"
      ? "in review"
      : status === "certification_failed"
        ? "cert failed"
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
        : status === "certification_failed"
          ? "bg-red-500/10 text-red-400 border-red-500/20"
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

function CertificationPanel({ report }: { report: CertificationReport | null }) {
  if (!report) return null;
  const blocking = report.findings.filter(
    (f) => f.severity === "blocker" || f.severity === "high",
  );
  const visible = blocking.length > 0 ? blocking : report.findings.slice(0, 3);
  const tone =
    report.status === "passed"
      ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
      : report.status === "needs_review"
        ? "border-amber-500/20 bg-amber-500/5 text-amber-300"
        : "border-red-500/20 bg-red-500/5 text-red-300";
  return (
    <div className={`mt-3 rounded-md border px-3 py-2 ${tone}`}>
      <div className="flex items-center justify-between gap-2 text-[11.5px]">
        <span className="uppercase tracking-[0.12em]">
          certification {report.status.replace("_", " ")}
        </span>
        <span className="text-lumo-fg-low">
          {report.tools.length} tool{report.tools.length === 1 ? "" : "s"}
        </span>
      </div>
      {visible.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {visible.map((f) => (
            <li key={`${f.code}:${f.evidence ?? ""}`} className="text-[12px]">
              <span className="font-medium">{f.code}</span>: {f.message}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 text-[12px]">No blocking findings.</div>
      )}
    </div>
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
