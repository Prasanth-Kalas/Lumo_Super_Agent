"use client";

/**
 * /admin/apps — every agent the orchestrator can route to, in one
 * filterable table.
 *
 * Source filter (Lumo / Partner / MCP) + status filter
 * (active / suspended / pending / rejected). Each row links to the
 * relevant detail surface — partner submissions go to /admin/review-
 * queue, runtime suspensions go via the policy buttons here.
 *
 * Read-mostly. Suspend/resume calls /api/admin/agent-policy which
 * is gated server-side.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface App {
  agent_id: string;
  display_name: string;
  one_liner: string;
  source: "lumo" | "partner" | "mcp";
  status: string;
  health_score: number | null;
  category: string | null;
  base_url: string | null;
  connect_model: string | null;
  runtime_status: "active" | "suspended" | "revoked" | null;
  publisher_email: string | null;
  manifest_url: string | null;
}

type SourceFilter = "all" | "lumo" | "partner" | "mcp";
type StatusFilter = "all" | "active" | "suspended" | "pending" | "rejected";

export default function AdminAppsPage() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/apps", { cache: "no-store" });
      if (res.status === 403) {
        setErr("Not on the admin allowlist.");
        setApps([]);
        return;
      }
      if (!res.ok) {
        setErr(`HTTP ${res.status}`);
        setApps([]);
        return;
      }
      const j = (await res.json()) as { apps?: App[] };
      setApps(j.apps ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setApps([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!apps) return [];
    return apps.filter((a) => {
      if (sourceFilter !== "all" && a.source !== sourceFilter) return false;
      if (statusFilter !== "all") {
        const effective = a.runtime_status ?? a.status;
        if (statusFilter === "active") {
          if (a.runtime_status === "suspended" || a.runtime_status === "revoked")
            return false;
          if (
            ["pending", "rejected", "revoked", "certification_failed"].includes(
              a.status,
            )
          ) {
            return false;
          }
          return true;
        }
        if (statusFilter === "suspended" && a.runtime_status !== "suspended")
          return false;
        if (statusFilter === "pending" && effective !== "pending") return false;
        if (
          statusFilter === "rejected" &&
          effective !== "rejected" &&
          effective !== "revoked" &&
          effective !== "certification_failed"
        ) {
          return false;
        }
      }
      return true;
    });
  }, [apps, sourceFilter, statusFilter]);

  async function setPolicy(
    agent_id: string,
    status: "active" | "suspended" | "revoked",
  ) {
    if (busyId) return;
    setBusyId(agent_id);
    try {
      const res = await fetch("/api/admin/agent-policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id,
          status,
          reason: status === "active" ? null : "Operator console",
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
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Apps</h1>
          <p className="text-[13px] text-lumo-fg-mid">
            Every agent the orchestrator can route to. Suspend or revoke takes
            effect on the next chat turn.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[12px] text-lumo-fg-mid hover:text-lumo-fg"
        >
          Refresh
        </button>
      </div>

      {err ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
          {err}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          label="Source"
          value={sourceFilter}
          options={[
            { v: "all", label: "All" },
            { v: "lumo", label: "Lumo" },
            { v: "partner", label: "Partner" },
            { v: "mcp", label: "MCP" },
          ]}
          onChange={(v) => setSourceFilter(v as SourceFilter)}
        />
        <FilterChips
          label="Status"
          value={statusFilter}
          options={[
            { v: "all", label: "All" },
            { v: "active", label: "Active" },
            { v: "suspended", label: "Suspended" },
            { v: "pending", label: "Pending" },
            { v: "rejected", label: "Rejected" },
          ]}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
        />
      </div>

      {!apps ? (
        <div className="text-[13px] text-lumo-fg-mid py-10">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-surface/40 p-8 text-center text-[13px] text-lumo-fg-mid">
          No apps match these filters.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-lumo-hair bg-lumo-surface">
          <table className="w-full text-[13px]">
            <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
              <tr className="border-b border-lumo-hair">
                <th className="text-left p-3 font-normal">Agent</th>
                <th className="text-left p-3 font-normal">Source</th>
                <th className="text-left p-3 font-normal">Status</th>
                <th className="text-right p-3 font-normal">Health</th>
                <th className="text-right p-3 font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const effectiveStatus = a.runtime_status ?? a.status;
                return (
                  <tr
                    key={a.agent_id}
                    className="border-b border-lumo-hair last:border-0"
                  >
                    <td className="p-3 align-top">
                      <div className="text-lumo-fg">{a.display_name}</div>
                      <div className="text-[11.5px] text-lumo-fg-low num truncate max-w-[280px]">
                        {a.agent_id}
                      </div>
                      {a.publisher_email ? (
                        <div className="text-[11px] text-lumo-fg-low mt-0.5">
                          by {a.publisher_email}
                        </div>
                      ) : null}
                    </td>
                    <td className="p-3 align-top">
                      <SourceBadge source={a.source} />
                    </td>
                    <td className="p-3 align-top">
                      <StatusBadge status={effectiveStatus} />
                    </td>
                    <td className="p-3 align-top text-right num">
                      {a.health_score === null
                        ? "—"
                        : `${Math.round(a.health_score * 100)}%`}
                    </td>
                    <td className="p-3 align-top text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {a.source === "partner" &&
                        ["pending", "certification_failed"].includes(a.status) ? (
                          <Link
                            href="/admin/review-queue"
                            className="h-7 px-2.5 rounded-md border border-lumo-hair text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated"
                          >
                            Review
                          </Link>
                        ) : null}
                        {a.runtime_status === "suspended" ? (
                          <button
                            type="button"
                            disabled={busyId === a.agent_id}
                            onClick={() => void setPolicy(a.agent_id, "active")}
                            className="h-7 px-2.5 rounded-md bg-lumo-fg text-lumo-bg text-[11.5px] hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:opacity-50"
                          >
                            Resume
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busyId === a.agent_id}
                            onClick={() =>
                              void setPolicy(a.agent_id, "suspended")
                            }
                            className="h-7 px-2.5 rounded-md border border-lumo-hair text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated disabled:opacity-50"
                          >
                            Suspend
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilterChips({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ v: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        {label}
      </span>
      <div className="inline-flex rounded-full border border-lumo-hair bg-lumo-surface p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={
              "h-7 px-3 rounded-full text-[11.5px] transition-colors " +
              (value === o.v
                ? "bg-lumo-fg text-lumo-bg"
                : "text-lumo-fg-mid hover:text-lumo-fg")
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: App["source"] }) {
  const label = source === "lumo" ? "Lumo" : source === "partner" ? "Partner" : "MCP";
  return (
    <span className="inline-flex items-center text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low border border-lumo-hair rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "active" || status === "registered" || status === "approved"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : status === "suspended" || status === "pending"
        ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
        : status === "rejected" ||
            status === "revoked" ||
            status === "certification_failed"
          ? "bg-red-500/10 text-red-400 border-red-500/20"
          : "bg-lumo-elevated text-lumo-fg-low border-lumo-hair";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] border " +
        tone
      }
    >
      {status}
    </span>
  );
}
