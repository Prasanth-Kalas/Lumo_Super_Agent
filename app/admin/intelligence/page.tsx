"use client";

/**
 * /admin/intelligence — observability dashboard for Lumo's intelligence
 * layer.
 *
 * Sibling to /admin/health (external monitor links + on-demand probe),
 * this page is the in-house view that's hard to delegate: cron lag,
 * brain reachability, ML tool latency, and the freshest proactive
 * moments + anomaly findings the proactive-scan pipeline has produced.
 *
 * Implemented as a client component so we can auto-refresh every 60s
 * without extra component files. The data path is /api/admin/
 * intelligence/stats which is server-side admin-gated by
 * LUMO_ADMIN_EMAILS — same pattern as /admin/apps and friends.
 *
 * If the API returns 403 the dashboard renders a "Forbidden" page; on
 * any other error a small banner shows the message and the table
 * continues to render the last-known-good payload (if any).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdminIntelligenceStats,
  BrainHealthSnapshot,
  CronHealthRow,
} from "@/lib/admin-stats-core";

const REFRESH_MS = 60_000;
const KNOWN_CRONS = [
  "/api/cron/proactive-scan",
  "/api/cron/index-archive",
  "/api/cron/sync-workspace",
] as const;

type LoadState = "loading" | "ok" | "forbidden" | "error";

export default function AdminIntelligencePage() {
  const [stats, setStats] = useState<AdminIntelligenceStats | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/intelligence/stats", {
        cache: "no-store",
      });
      if (res.status === 403) {
        setState("forbidden");
        return;
      }
      if (!res.ok) {
        setState("error");
        setErr(`HTTP ${res.status}`);
        return;
      }
      const j = (await res.json()) as AdminIntelligenceStats;
      setStats(j);
      setState("ok");
      setErr(null);
    } catch (e) {
      setState("error");
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  if (state === "forbidden") {
    return (
      <div className="space-y-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
          Forbidden
        </h1>
        <p className="text-[13px] text-lumo-fg-mid">
          You are signed in but not on the admin allowlist
          (<code className="text-lumo-fg">LUMO_ADMIN_EMAILS</code>).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            Intelligence
          </h1>
          <p className="text-[13px] text-lumo-fg-mid">
            Cron lag, brain reachability, ML tool latency, and the
            freshest proactive moments + anomaly findings. Refreshes
            every 60s.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11.5px] text-lumo-fg-low num">
            {stats?.generated_at
              ? formatTimestamp(stats.generated_at)
              : state === "loading"
                ? "Loading…"
                : "—"}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg"
          >
            Refresh
          </button>
        </div>
      </div>

      {err ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
          {err}
        </div>
      ) : null}

      {!stats ? (
        <div className="text-[13px] text-lumo-fg-mid py-10">Loading…</div>
      ) : (
        <IntelligenceContent stats={stats} />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Layout
// ──────────────────────────────────────────────────────────────────────────

function IntelligenceContent({ stats }: { stats: AdminIntelligenceStats }) {
  const cronByEndpoint = new Map(
    stats.cron_health.map((r) => [r.endpoint, r] as const),
  );

  return (
    <>
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <BrainHealthCard snap={stats.brain_health} />
        {KNOWN_CRONS.map((ep) => (
          <CronCard
            key={ep}
            endpoint={ep}
            row={cronByEndpoint.get(ep) ?? null}
          />
        ))}
      </section>

      <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-3">
        <SectionHeader
          title="Brain tool latency"
          sub="Last 24h of agent_tool_usage rows where agent_id = lumo-ml."
        />
        {stats.brain_tool_stats.length === 0 ? (
          <Empty label="No brain tool calls in the last 24h." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
                <tr className="border-b border-lumo-hair">
                  <th className="text-left p-2 font-normal">Tool</th>
                  <th className="text-right p-2 font-normal">Calls</th>
                  <th className="text-right p-2 font-normal">OK %</th>
                  <th className="text-right p-2 font-normal">p50</th>
                  <th className="text-right p-2 font-normal">p95</th>
                </tr>
              </thead>
              <tbody>
                {stats.brain_tool_stats.map((t) => (
                  <tr
                    key={t.tool_name}
                    className="border-b border-lumo-hair last:border-0"
                  >
                    <td className="p-2 align-top text-lumo-fg num">
                      {t.tool_name}
                    </td>
                    <td className="p-2 align-top text-right num">
                      {t.call_count_24h}
                    </td>
                    <td className="p-2 align-top text-right num">
                      {Math.round(t.ok_rate_24h * 100)}%
                    </td>
                    <td className="p-2 align-top text-right num">
                      {t.latency_p50_ms}ms
                    </td>
                    <td className="p-2 align-top text-right num">
                      {t.latency_p95_ms}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-3">
        <SectionHeader
          title="Recent proactive moments"
          sub="20 newest rows from proactive_moments. Body is truncated at 120 chars."
        />
        {stats.recent_proactive_moments.length === 0 ? (
          <Empty label="No proactive moments yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
                <tr className="border-b border-lumo-hair">
                  <th className="text-left p-2 font-normal">Type</th>
                  <th className="text-left p-2 font-normal">Title</th>
                  <th className="text-left p-2 font-normal">Excerpt</th>
                  <th className="text-left p-2 font-normal">Urgency</th>
                  <th className="text-left p-2 font-normal">Status</th>
                  <th className="text-right p-2 font-normal">Age</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent_proactive_moments.map((m) => (
                  <tr
                    key={m.id}
                    className="border-b border-lumo-hair last:border-0"
                  >
                    <td className="p-2 align-top text-[11.5px] text-lumo-fg-low num">
                      {m.moment_type}
                    </td>
                    <td className="p-2 align-top text-lumo-fg max-w-[260px] truncate">
                      {m.title}
                    </td>
                    <td className="p-2 align-top text-[11.5px] text-lumo-fg-mid max-w-[360px] truncate">
                      {m.body_excerpt}
                    </td>
                    <td className="p-2 align-top">
                      <UrgencyBadge urgency={m.urgency} />
                    </td>
                    <td className="p-2 align-top text-[11.5px] text-lumo-fg-low">
                      {m.status}
                    </td>
                    <td className="p-2 align-top text-right text-[11.5px] text-lumo-fg-low num">
                      {formatAge(m.age_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-3">
        <SectionHeader
          title="Recent anomaly findings"
          sub="20 newest rows from anomaly_findings."
        />
        {stats.recent_anomaly_findings.length === 0 ? (
          <Empty label="No anomalies detected yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
                <tr className="border-b border-lumo-hair">
                  <th className="text-left p-2 font-normal">Metric</th>
                  <th className="text-left p-2 font-normal">Type</th>
                  <th className="text-right p-2 font-normal">Actual</th>
                  <th className="text-right p-2 font-normal">Expected</th>
                  <th className="text-right p-2 font-normal">z</th>
                  <th className="text-right p-2 font-normal">Conf.</th>
                  <th className="text-right p-2 font-normal">Age</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent_anomaly_findings.map((f) => (
                  <tr
                    key={f.id}
                    className="border-b border-lumo-hair last:border-0"
                  >
                    <td className="p-2 align-top text-lumo-fg num">
                      {f.metric_key}
                    </td>
                    <td className="p-2 align-top text-[11.5px] text-lumo-fg-low">
                      {f.finding_type}
                    </td>
                    <td className="p-2 align-top text-right num">
                      {formatNumber(f.actual_value)}
                    </td>
                    <td className="p-2 align-top text-right num text-lumo-fg-low">
                      {f.expected_value === null
                        ? "—"
                        : formatNumber(f.expected_value)}
                    </td>
                    <td className="p-2 align-top text-right num">
                      {f.z_score === null ? "—" : f.z_score.toFixed(2)}
                    </td>
                    <td className="p-2 align-top text-right num text-lumo-fg-low">
                      {f.confidence === null
                        ? "—"
                        : `${Math.round(f.confidence * 100)}%`}
                    </td>
                    <td className="p-2 align-top text-right text-[11.5px] text-lumo-fg-low num">
                      {formatAge(f.age_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Card primitives
// ──────────────────────────────────────────────────────────────────────────

function BrainHealthCard({ snap }: { snap: BrainHealthSnapshot }) {
  const tone =
    snap.status === "ok"
      ? "border-emerald-500/30"
      : snap.status === "degraded"
        ? "border-amber-500/30"
        : "border-red-500/30";
  return (
    <div className={"rounded-xl border bg-lumo-surface p-4 space-y-2 " + tone}>
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        Brain
      </div>
      <div className="text-[16px] font-semibold tracking-tight text-lumo-fg">
        {snap.status}
      </div>
      <dl className="text-[11.5px] text-lumo-fg-mid space-y-0.5">
        <div className="flex justify-between">
          <dt>Service JWT</dt>
          <dd className="num">{snap.service_jwt}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Sandbox</dt>
          <dd className="num">{snap.sandbox}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Modal</dt>
          <dd className="num">{snap.modal}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Probed</dt>
          <dd className="num">{Math.round(snap.age_ms)}ms ago</dd>
        </div>
      </dl>
    </div>
  );
}

function CronCard({
  endpoint,
  row,
}: {
  endpoint: string;
  row: CronHealthRow | null;
}) {
  const label = endpoint.replace("/api/cron/", "");
  const failures = row?.fail_count_24h ?? 0;
  const tone =
    failures === 0
      ? "border-lumo-hair"
      : failures < 3
        ? "border-amber-500/30"
        : "border-red-500/30";
  return (
    <div className={"rounded-xl border bg-lumo-surface p-4 space-y-2 " + tone}>
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        Cron
      </div>
      <div className="text-[14px] font-semibold tracking-tight text-lumo-fg num truncate">
        {label}
      </div>
      <dl className="text-[11.5px] text-lumo-fg-mid space-y-0.5">
        <div className="flex justify-between">
          <dt>Last run</dt>
          <dd className="num">
            {row?.last_run_at ? formatTimestamp(row.last_run_at) : "—"}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>OK / fail (24h)</dt>
          <dd className="num">
            {row?.ok_count_24h ?? 0} / {failures}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>p95</dt>
          <dd className="num">
            {row?.latency_p95_ms == null ? "—" : `${row.latency_p95_ms}ms`}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function SectionHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="space-y-0.5">
      <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
      <p className="text-[12px] text-lumo-fg-mid">{sub}</p>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-lumo-hair bg-lumo-surface/40 p-6 text-center text-[12.5px] text-lumo-fg-low">
      {label}
    </div>
  );
}

function UrgencyBadge({ urgency }: { urgency: string }) {
  const tone =
    urgency === "high"
      ? "bg-red-500/10 text-red-400 border-red-500/20"
      : urgency === "low"
        ? "bg-lumo-elevated text-lumo-fg-low border-lumo-hair"
        : "bg-amber-500/10 text-amber-400 border-amber-500/20";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] border " +
        tone
      }
    >
      {urgency}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}
