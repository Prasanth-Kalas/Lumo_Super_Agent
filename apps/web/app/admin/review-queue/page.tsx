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
  version: string;
  is_published: boolean;
  logo_url: string | null;
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

interface DeveloperApplication {
  email: string;
  display_name: string | null;
  company: string | null;
  reason: string | null;
  tier: "waitlisted" | "approved" | "rejected" | "revoked";
  capability_tier: "tier_1" | "tier_2" | "tier_3";
  reviewer_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string | null;
}

type CapabilityTier = "tier_1" | "tier_2" | "tier_3";

const CAPABILITY_TIER_LABEL: Record<CapabilityTier, string> = {
  tier_1: "tier_1 (free + low)",
  tier_2: "tier_2 (+ metered)",
  tier_3: "tier_3 (+ money)",
};

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
  /** Per-agent (cross-user) ceilings. null = no cap. */
  max_calls_per_agent_per_minute: number | null;
  daily_cost_ceiling_usd: number | null;
  monthly_cost_ceiling_usd: number | null;
}

interface RuntimePolicyUpdate {
  status?: RuntimeOverride["status"];
  /** Pass null to clear an existing ceiling, a positive number to set. */
  max_calls_per_agent_per_minute?: number | null;
  daily_cost_ceiling_usd?: number | null;
  monthly_cost_ceiling_usd?: number | null;
}

export default function AdminReviewQueuePage() {
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [policies, setPolicies] = useState<RuntimeOverride[]>([]);
  const [developers, setDevelopers] = useState<DeveloperApplication[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [res, policyRes, devsRes] = await Promise.all([
        fetch("/api/admin/review-queue", { cache: "no-store" }),
        fetch("/api/admin/agent-policy", { cache: "no-store" }),
        fetch("/api/admin/developers", { cache: "no-store" }),
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
      if (devsRes.ok) {
        const d = (await devsRes.json()) as {
          developers?: DeveloperApplication[];
        };
        setDevelopers(d.developers ?? []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSubs([]);
    }
  }, []);

  async function decideDeveloper(
    email: string,
    decision: DeveloperApplication["tier"],
    capability_tier?: CapabilityTier,
  ) {
    if (busyId) return;
    setBusyId(`dev:${email}`);
    try {
      const res = await fetch("/api/admin/developers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          decision,
          note: note.trim() || undefined,
          // Only include capability_tier when explicitly chosen so a
          // re-decision (e.g. flipping rejected→waitlisted) doesn't
          // wipe an admin-tuned tier.
          ...(capability_tier && { capability_tier }),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.error as string | undefined) ?? `HTTP ${res.status}`,
        );
      }
      setNote("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function setDeveloperTier(email: string, capability_tier: CapabilityTier) {
    // Tier-only update for an already-approved row. Reuses the
    // /api/admin/developers POST endpoint with the existing tier so
    // the row's status doesn't change.
    const current = developers.find((d) => d.email === email);
    if (!current) return;
    await decideDeveloper(email, current.tier, capability_tier);
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(
    id: string,
    decision:
      | "approved"
      | "rejected"
      | "revoked"
      | "published"
      | "unpublished",
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
    update: RuntimePolicyUpdate,
  ) {
    if (busyId) return;
    setBusyId(`policy:${agent_id}`);
    try {
      // Status is required by the API. If the caller is only
      // adjusting ceilings without flipping status, fall back to
      // the current policy's status (or "active" for first-time).
      const currentStatus =
        policies.find((p) => p.agent_id === agent_id)?.status ?? "active";
      const status = update.status ?? currentStatus;
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
          // Pass through ceiling deltas only when explicitly set in
          // the update — leaves omitted fields untouched on the
          // server (the route's parseClearableLimit helper handles
          // the null/undefined distinction).
          ...(update.max_calls_per_agent_per_minute !== undefined && {
            max_calls_per_agent_per_minute:
              update.max_calls_per_agent_per_minute,
          }),
          ...(update.daily_cost_ceiling_usd !== undefined && {
            daily_cost_ceiling_usd: update.daily_cost_ceiling_usd,
          }),
          ...(update.monthly_cost_ceiling_usd !== undefined && {
            monthly_cost_ceiling_usd: update.monthly_cost_ceiling_usd,
          }),
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
            <LumoWordmark height={22} />
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

        <DeveloperApplicationsPanel
          developers={developers}
          busyId={busyId}
          onDecide={(email, decision) => void decideDeveloper(email, decision)}
          onSetTier={(email, tier) => void setDeveloperTier(email, tier)}
        />

        <div className="mb-3 mt-8 flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">Agent submissions</h2>
          <span className="text-[11px] text-lumo-fg-low num">
            {subs?.length ?? 0} total
          </span>
        </div>

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
                      <div className="text-[13.5px] text-lumo-fg flex items-center gap-2">
                        <span>{displayNameOf(s)}</span>
                        <span className="text-[11px] text-lumo-fg-low num">
                          v{s.version}
                        </span>
                        {s.is_published ? (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                            Live
                          </span>
                        ) : null}
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
                      onSet={(update) => void setRuntimePolicy(agentIdOf(s), update)}
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
                      {s.status === "approved" && !s.is_published ? (
                        <button
                          type="button"
                          onClick={() => void decide(s.id, "published")}
                          disabled={busyId === s.id}
                          className="h-8 px-3 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[12.5px] hover:bg-emerald-500/25 disabled:opacity-50"
                          title="Make this the version live on the marketplace. Replaces the currently published version, if any."
                        >
                          Publish
                        </button>
                      ) : null}
                      {s.is_published ? (
                        <button
                          type="button"
                          onClick={() => void decide(s.id, "unpublished")}
                          disabled={busyId === s.id}
                          className="h-8 px-3 rounded-md border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 text-[12.5px] disabled:opacity-50"
                          title="Pull this version off the marketplace. The agent disappears from users until another version is published."
                        >
                          Unpublish
                        </button>
                      ) : null}
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
  onSet: (update: RuntimePolicyUpdate) => void;
}) {
  const [editingCeilings, setEditingCeilings] = useState(false);
  const [agentMin, setAgentMin] = useState("");
  const [dailyUsd, setDailyUsd] = useState("");
  const [monthlyUsd, setMonthlyUsd] = useState("");

  // Re-seed the inputs whenever the policy snapshot changes (e.g.,
  // after a successful save). Empty string represents "no cap"
  // explicitly so the user can distinguish it from a cleared field.
  useEffect(() => {
    setAgentMin(
      policy?.max_calls_per_agent_per_minute != null
        ? String(policy.max_calls_per_agent_per_minute)
        : "",
    );
    setDailyUsd(
      policy?.daily_cost_ceiling_usd != null
        ? String(policy.daily_cost_ceiling_usd)
        : "",
    );
    setMonthlyUsd(
      policy?.monthly_cost_ceiling_usd != null
        ? String(policy.monthly_cost_ceiling_usd)
        : "",
    );
  }, [
    policy?.max_calls_per_agent_per_minute,
    policy?.daily_cost_ceiling_usd,
    policy?.monthly_cost_ceiling_usd,
  ]);

  if (!agent_id) return null;
  const status = policy?.status ?? "active";

  const ceilingSummary = (() => {
    if (!policy) return null;
    const parts: string[] = [];
    if (policy.max_calls_per_agent_per_minute != null) {
      parts.push(`${policy.max_calls_per_agent_per_minute}/min agent-wide`);
    }
    if (policy.daily_cost_ceiling_usd != null) {
      parts.push(`$${policy.daily_cost_ceiling_usd}/day`);
    }
    if (policy.monthly_cost_ceiling_usd != null) {
      parts.push(`$${policy.monthly_cost_ceiling_usd}/mo`);
    }
    return parts.length ? parts.join(" · ") : null;
  })();

  function saveCeilings() {
    onSet({
      max_calls_per_agent_per_minute: parseFieldToClearable(agentMin, "int"),
      daily_cost_ceiling_usd: parseFieldToClearable(dailyUsd, "money"),
      monthly_cost_ceiling_usd: parseFieldToClearable(monthlyUsd, "money"),
    });
    setEditingCeilings(false);
  }

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
          <div className="text-[11px] text-lumo-fg-low mt-0.5">
            agent-wide ceilings: {ceilingSummary ?? "none"}
          </div>
          {policy?.reason ? (
            <div className="mt-1 text-[11px] text-lumo-fg-low">
              reason: {policy.reason}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditingCeilings((v) => !v)}
            disabled={busy}
            className="h-7 px-2.5 rounded-md border border-lumo-hair text-lumo-fg-mid text-[12px] hover:bg-lumo-elevated disabled:opacity-50"
          >
            {editingCeilings ? "Cancel" : "Ceilings"}
          </button>
          {status === "active" ? (
            <button
              type="button"
              onClick={() => onSet({ status: "suspended" })}
              disabled={busy}
              className="h-7 px-2.5 rounded-md border border-amber-500/30 text-amber-400 text-[12px] hover:bg-amber-500/10 disabled:opacity-50"
            >
              Suspend
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSet({ status: "active" })}
              disabled={busy}
              className="h-7 px-2.5 rounded-md border border-emerald-500/30 text-emerald-400 text-[12px] hover:bg-emerald-500/10 disabled:opacity-50"
            >
              Reactivate
            </button>
          )}
          {status !== "revoked" ? (
            <button
              type="button"
              onClick={() => onSet({ status: "revoked" })}
              disabled={busy}
              className="h-7 px-2.5 rounded-md border border-red-500/30 text-red-400 text-[12px] hover:bg-red-500/10 disabled:opacity-50"
            >
              Kill
            </button>
          ) : null}
        </div>
      </div>
      {editingCeilings ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <CeilingInput
            label="calls/min"
            value={agentMin}
            onChange={setAgentMin}
            placeholder="no cap"
          />
          <CeilingInput
            label="$/day"
            value={dailyUsd}
            onChange={setDailyUsd}
            placeholder="no cap"
          />
          <CeilingInput
            label="$/month"
            value={monthlyUsd}
            onChange={setMonthlyUsd}
            placeholder="no cap"
          />
          <div className="col-span-3 flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-lumo-fg-low">
              Empty = no cap (clears any existing). All caps apply across all
              users.
            </span>
            <button
              type="button"
              onClick={saveCeilings}
              disabled={busy}
              className="h-7 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:opacity-50"
            >
              Save ceilings
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CeilingInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] text-lumo-fg-low">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 px-2 rounded-md border border-lumo-hair bg-lumo-bg text-[12px] num focus:border-lumo-edge outline-none"
      />
    </label>
  );
}

/**
 * Parse a free-form input into the tri-state ceiling representation:
 *   - empty / whitespace → null (clear the cap)
 *   - positive number → set cap (int for counts, decimal for money)
 *   - anything else (negative, NaN) → undefined (don't send field)
 */
function parseFieldToClearable(
  raw: string,
  kind: "int" | "money",
): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (kind === "int" && !Number.isInteger(n)) return undefined;
  return n;
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

function DeveloperApplicationsPanel({
  developers,
  busyId,
  onDecide,
  onSetTier,
}: {
  developers: DeveloperApplication[];
  busyId: string | null;
  onDecide: (email: string, decision: DeveloperApplication["tier"]) => void;
  onSetTier: (email: string, tier: CapabilityTier) => void;
}) {
  // Default-collapsed when nothing is waiting; expand whenever any
  // application is in `waitlisted` so the admin doesn't miss it.
  const waitlistedCount = developers.filter(
    (d) => d.tier === "waitlisted",
  ).length;
  const [open, setOpen] = useState(waitlistedCount > 0);

  // Re-open whenever a fresh waitlisted item shows up after the
  // admin had collapsed the panel (rare, but cheap).
  useEffect(() => {
    if (waitlistedCount > 0) setOpen(true);
  }, [waitlistedCount]);

  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center justify-between"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold">
            Developer applications
          </span>
          {waitlistedCount > 0 ? (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
              {waitlistedCount} waiting
            </span>
          ) : null}
        </div>
        <span className="text-[11px] text-lumo-fg-low">
          {developers.length} total · {open ? "hide" : "show"}
        </span>
      </button>
      {open ? (
        developers.length === 0 ? (
          <div className="border-t border-lumo-hair px-4 py-4 text-[12.5px] text-lumo-fg-mid">
            No applications yet.
          </div>
        ) : (
          <ul className="border-t border-lumo-hair divide-y divide-lumo-hair">
            {developers.map((d) => (
              <li key={d.email} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-lumo-fg flex items-center gap-2">
                      <span className="truncate">
                        {d.display_name || d.email}
                      </span>
                      {d.company ? (
                        <span className="text-[11px] text-lumo-fg-low">
                          · {d.company}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-lumo-fg-low num truncate">
                      {d.email}
                      {d.created_at ? ` · applied ${formatShort(d.created_at)}` : null}
                    </div>
                    {d.reason ? (
                      <div className="mt-1 text-[12px] text-lumo-fg-mid">
                        {d.reason}
                      </div>
                    ) : null}
                    {d.reviewer_note ? (
                      <div className="mt-1 text-[11.5px] text-lumo-fg-low">
                        last note: {d.reviewer_note}
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-2">
                    <DeveloperTierPill tier={d.tier} />
                    {d.tier === "approved" ? (
                      <label className="flex items-center gap-1.5 text-[10.5px] text-lumo-fg-low">
                        cap
                        <select
                          value={d.capability_tier ?? "tier_1"}
                          onChange={(e) =>
                            onSetTier(d.email, e.target.value as CapabilityTier)
                          }
                          disabled={busyId === `dev:${d.email}`}
                          className="h-6 px-1.5 rounded border border-lumo-hair bg-lumo-bg text-[11px] text-lumo-fg focus:border-lumo-edge outline-none disabled:opacity-50"
                          title="Capability tier — gates which cost_tiers this developer's agents may expose."
                        >
                          {(["tier_1", "tier_2", "tier_3"] as const).map((t) => (
                            <option key={t} value={t}>
                              {CAPABILITY_TIER_LABEL[t]}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <div className="flex items-center gap-1.5">
                      {d.tier !== "approved" ? (
                        <button
                          type="button"
                          onClick={() => onDecide(d.email, "approved")}
                          disabled={busyId === `dev:${d.email}`}
                          className="h-7 px-2.5 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[12px] hover:bg-emerald-500/25 disabled:opacity-50"
                        >
                          Approve
                        </button>
                      ) : null}
                      {d.tier === "waitlisted" ? (
                        <button
                          type="button"
                          onClick={() => onDecide(d.email, "rejected")}
                          disabled={busyId === `dev:${d.email}`}
                          className="h-7 px-2.5 rounded-md border border-red-500/30 text-red-400 text-[12px] hover:bg-red-500/10 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      ) : null}
                      {d.tier === "approved" ? (
                        <button
                          type="button"
                          onClick={() => onDecide(d.email, "revoked")}
                          disabled={busyId === `dev:${d.email}`}
                          className="h-7 px-2.5 rounded-md border border-red-500/30 text-red-400 text-[12px] hover:bg-red-500/10 disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

function DeveloperTierPill({ tier }: { tier: DeveloperApplication["tier"] }) {
  const tone =
    tier === "approved"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : tier === "waitlisted"
        ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
        : "bg-red-500/10 text-red-400 border-red-500/20";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] border " +
        tone
      }
    >
      {tier}
    </span>
  );
}
