"use client";

/**
 * /admin/review-queue — Lumo-team inbox for partner submissions.
 *
 * Shows every pending submission at the top, reviewed ones below.
 * Each row expands to show the parsed manifest JSON for inspection.
 * Reviewer can approve, reject, or revoke (for previously-approved
 * rows that need to be pulled) with an optional note that surfaces
 * back to the publisher on /publisher.
 *
 * Admin-gated both client- and server-side. Client-side gate here
 * is UX-only; the server routes enforce the real check.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Submission {
  id: string;
  publisher_email: string;
  manifest_url: string;
  parsed_manifest: Record<string, unknown> | null;
  status: "pending" | "certification_failed" | "approved" | "rejected" | "revoked";
  certification_status: "passed" | "needs_review" | "failed" | null;
  certification_report: CertificationReport | null;
  certified_at: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewer_note: string | null;
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
  tools: Array<{
    name: string;
    cost_tier: string;
    requires_confirmation: string | false;
    pii_required: string[];
  }>;
}

interface RuntimeOverride {
  agent_id: string;
  status: "active" | "suspended" | "revoked";
  reason: string | null;
  max_calls_per_user_per_minute: number;
  max_calls_per_user_per_day: number;
  max_money_calls_per_user_per_day: number;
}

export default function AdminReviewQueuePage() {
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [policies, setPolicies] = useState<RuntimeOverride[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [res, policyRes] = await Promise.all([
        fetch("/api/admin/review-queue", { cache: "no-store" }),
        fetch("/api/admin/agent-policy", { cache: "no-store" }),
      ]);
      if (res.status === 403) {
        setErr(
          "You're signed in but not on the admin allowlist. Add your email to LUMO_ADMIN_EMAILS.",
        );
        setSubs([]);
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.error as string | undefined) ?? `HTTP ${res.status}`,
        );
      }
      const j = (await res.json()) as { submissions?: Submission[] };
      setSubs(j.submissions ?? []);
      if (policyRes.ok) {
        const p = (await policyRes.json()) as { overrides?: RuntimeOverride[] };
        setPolicies(p.overrides ?? []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSubs([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(
    id: string,
    decision: "approved" | "rejected" | "revoked",
  ) {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch("/api/admin/review-queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submission_id: id,
          decision,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.error as string | undefined) ?? `HTTP ${res.status}`,
        );
      }
      setNote("");
      setExpanded(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function setRuntimePolicy(
    agent_id: string,
    status: RuntimeOverride["status"],
  ) {
    if (busyId) return;
    setBusyId(`policy:${agent_id}`);
    try {
      const res = await fetch("/api/admin/agent-policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id,
          status,
          reason:
            status === "active"
              ? null
              : note.trim() || "Admin runtime override",
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.error as string | undefined) ?? `HTTP ${res.status}`,
        );
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex flex-col">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3">
          <Link
            href="/"
            className="flex items-center gap-2.5 hover:opacity-90 transition-opacity"
          >
            <LumoWordmark height={20} />
            <span className="hidden sm:inline text-[12px] text-lumo-fg-low">
              /
            </span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Admin — review queue</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-5 py-10 flex-1">
        {err ? (
          <div className="mb-5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
            {err}
          </div>
        ) : null}

        {!subs ? (
          <div className="text-[13px] text-lumo-fg-mid py-10">Loading…</div>
        ) : subs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-surface/40 p-10 text-center text-[13px] text-lumo-fg-mid">
            Queue is empty.
          </div>
        ) : (
          <ul className="space-y-2">
            {subs.map((s) => (
              <li
                key={s.id}
                className="rounded-xl border border-lumo-hair bg-lumo-surface"
              >
                <button
                  type="button"
                  onClick={() =>
                    setExpanded(expanded === s.id ? null : s.id)
                  }
                  className="w-full text-left px-4 py-3"
                  aria-expanded={expanded === s.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] text-lumo-fg">
                        {displayNameOf(s)}
                      </div>
                      <div className="text-[11.5px] text-lumo-fg-low num mt-0.5 truncate">
                        {s.publisher_email} · {s.manifest_url}
                      </div>
                    </div>
                    <StatusPill status={s.status} />
                  </div>
                </button>

                {expanded === s.id ? (
                  <div className="border-t border-lumo-hair px-4 py-3 space-y-3">
                    <pre className="text-[11.5px] text-lumo-fg-mid bg-lumo-bg border border-lumo-hair rounded-md p-3 overflow-x-auto max-h-64">
                      {JSON.stringify(s.parsed_manifest, null, 2)}
                    </pre>

                    <CertificationPanel report={s.certification_report} />
                    <RuntimePolicyPanel
                      agent_id={agentIdOf(s)}
                      policy={policies.find((p) => p.agent_id === agentIdOf(s)) ?? null}
                      busy={busyId === `policy:${agentIdOf(s)}`}
                      onSet={(status) => void setRuntimePolicy(agentIdOf(s), status)}
                    />

                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Reviewer note (optional — surfaces to the publisher)"
                      className="w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13px] placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
                    />

                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => void decide(s.id, "approved")}
                        disabled={busyId === s.id || s.certification_status !== "passed"}
                        className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:opacity-50"
                      >
                        {busyId === s.id ? "…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void decide(s.id, "rejected")}
                        disabled={busyId === s.id}
                        className="h-8 px-3 rounded-md border border-red-500/30 text-red-400 text-[12.5px] hover:bg-red-500/10 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      {s.status === "approved" ? (
                        <button
                          type="button"
                          onClick={() => void decide(s.id, "revoked")}
                          disabled={busyId === s.id}
                          className="h-8 px-3 rounded-md border border-lumo-hair text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated text-[12.5px] disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      ) : null}
                      {s.reviewer_note ? (
                        <span className="text-[11.5px] text-lumo-fg-low ml-auto">
                          last note: {s.reviewer_note}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function displayNameOf(s: Submission): string {
  const m = s.parsed_manifest as
    | { display_name?: string; agent_id?: string }
    | null;
  return m?.display_name ?? m?.agent_id ?? s.manifest_url;
}

function agentIdOf(s: Submission): string {
  const m = s.parsed_manifest as { agent_id?: string } | null;
  return m?.agent_id ?? "";
}

function StatusPill({ status }: { status: Submission["status"] }) {
  const label =
    status === "pending"
      ? "pending"
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
        : "bg-lumo-elevated text-lumo-fg-low border-lumo-hair";
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
  if (!report) {
    return (
      <div className="rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[12px] text-lumo-fg-low">
        No certification report stored.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[12.5px] font-medium">
            Certification: {report.status.replace("_", " ")}
          </div>
          <div className="text-[11px] text-lumo-fg-low num">
            {report.tools.length} tools · checked {formatShort(report.checked_at)}
          </div>
        </div>
        <div className="text-[11px] text-lumo-fg-low num">
          B{report.summary.blocker} H{report.summary.high} M{report.summary.medium}
        </div>
      </div>
      {report.findings.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {report.findings.map((f) => (
            <li
              key={`${f.severity}:${f.code}:${f.evidence ?? ""}`}
              className="text-[11.5px] text-lumo-fg-mid"
            >
              <span className="uppercase text-lumo-fg-low">{f.severity}</span>{" "}
              <span className="font-medium text-lumo-fg">{f.code}</span>:{" "}
              {f.message}
              {f.evidence ? (
                <span className="text-lumo-fg-low"> ({f.evidence})</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 text-[11.5px] text-lumo-fg-mid">
          No findings. This agent is eligible for approval.
        </div>
      )}
    </div>
  );
}

function RuntimePolicyPanel({
  agent_id,
  policy,
  busy,
  onSet,
}: {
  agent_id: string;
  policy: RuntimeOverride | null;
  busy: boolean;
  onSet: (status: RuntimeOverride["status"]) => void;
}) {
  if (!agent_id) return null;
  const status = policy?.status ?? "active";
  return (
    <div className="rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12.5px] font-medium">
            Runtime policy: {status}
          </div>
          <div className="text-[11px] text-lumo-fg-low">
            {policy
              ? `${policy.max_calls_per_user_per_minute}/min · ${policy.max_calls_per_user_per_day}/day · ${policy.max_money_calls_per_user_per_day} money/day`
              : "Default quotas"}
          </div>
          {policy?.reason ? (
            <div className="mt-1 text-[11px] text-lumo-fg-low">
              reason: {policy.reason}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {status === "active" ? (
            <button
              type="button"
              onClick={() => onSet("suspended")}
              disabled={busy}
              className="h-7 px-2.5 rounded-md border border-amber-500/30 text-amber-400 text-[12px] hover:bg-amber-500/10 disabled:opacity-50"
            >
              Suspend
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSet("active")}
              disabled={busy}
              className="h-7 px-2.5 rounded-md border border-emerald-500/30 text-emerald-400 text-[12px] hover:bg-emerald-500/10 disabled:opacity-50"
            >
              Reactivate
            </button>
          )}
          {status !== "revoked" ? (
            <button
              type="button"
              onClick={() => onSet("revoked")}
              disabled={busy}
              className="h-7 px-2.5 rounded-md border border-red-500/30 text-red-400 text-[12px] hover:bg-red-500/10 disabled:opacity-50"
            >
              Kill
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
