"use client";

/**
 * /ops — operator console.
 *
 * Read-only. Admin-only via LUMO_ADMIN_EMAILS env allowlist. Non-admins
 * see a 403 message; logged-out users get bounced by middleware.
 *
 * Four sections, each a simple card strip:
 *   1. Cron health — one card per known cron with last-run lag +
 *      24h success ratio + last counts + last errors.
 *   2. Autonomy — 7d totals by outcome, distinct users, cents handled.
 *   3. Pattern detector — active rows, users, avg confidence.
 *   4. Notifications — 24h/7d delivered, unread live, by-kind 7d.
 *
 * Polls /api/ops/summary every 30s while the tab is visible.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface CronHealthRow {
  endpoint: string;
  last_run_at: string | null;
  last_ok: boolean | null;
  last_latency_ms: number | null;
  last_counts: Record<string, number> | null;
  last_errors: string[] | null;
  runs_24h: number;
  failures_24h: number;
}
interface AutonomyStats {
  total_7d: number;
  by_outcome: Record<string, number>;
  total_amount_cents_7d: number;
  distinct_users_7d: number;
}
interface PatternStats {
  active_rows_7d: number;
  distinct_users_7d: number;
  avg_confidence: number | null;
}
interface NotificationStats {
  delivered_24h: number;
  delivered_7d: number;
  unread_live: number;
  by_kind_7d: Record<string, number>;
}

interface Summary {
  crons: CronHealthRow[];
  autonomy: AutonomyStats;
  patterns: PatternStats;
  notifications: NotificationStats;
  generated_at: string;
}

const POLL_MS = 30_000;

export default function OpsPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/ops/summary", { cache: "no-store" });
    if (res.status === 403) {
      setForbidden(true);
      return;
    }
    if (!res.ok) {
      setError(`Failed (${res.status})`);
      return;
    }
    setError(null);
    setData(await res.json());
  }, []);

  useEffect(() => {
    let alive = true;
    void load();
    function schedule() {
      if (pollRef.current != null) return;
      pollRef.current = window.setInterval(() => {
        if (!alive) return;
        if (typeof document !== "undefined" && document.hidden) return;
        void load();
      }, POLL_MS);
    }
    schedule();
    function onVis() {
      if (!document.hidden) void load();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  if (forbidden) {
    return (
      <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex items-center justify-center px-5">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-[20px] font-semibold">Not your dashboard</h1>
          <p className="text-[13px] text-lumo-fg-mid">
            /ops is reserved for Lumo operators. If you need access, add your email
            to <code className="font-mono text-lumo-fg">LUMO_ADMIN_EMAILS</code>.
          </p>
          <Link href="/" className="text-[12.5px] text-lumo-accent hover:underline">
            Back to Lumo
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center hover:opacity-90 transition-opacity">
              <LumoWordmark height={22} />
            </Link>
            <span className="text-lumo-fg-low text-[12px]">/</span>
            <span className="text-[13px] text-lumo-fg">Ops</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-lumo-fg-low num tracking-wide">
              {data ? `updated ${new Date(data.generated_at).toLocaleTimeString()}` : "loading…"}
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-5 py-8 space-y-8">
        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            {error}
          </div>
        ) : null}

        {!data ? (
          <div className="text-[13px] text-lumo-fg-mid py-10">Loading…</div>
        ) : (
          <>
            {/* ─── Crons ───────────────────────────────────────── */}
            <section className="space-y-3">
              <h2 className="text-[15px] font-semibold text-lumo-fg">Cron health</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {data.crons.map((c) => (
                  <CronCard key={c.endpoint} c={c} />
                ))}
              </div>
            </section>

            {/* ─── Autonomy ────────────────────────────────────── */}
            <section className="space-y-3">
              <h2 className="text-[15px] font-semibold text-lumo-fg">Autonomy (7d)</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  label="Actions"
                  value={String(data.autonomy.total_7d)}
                />
                <StatCard
                  label="Distinct users"
                  value={String(data.autonomy.distinct_users_7d)}
                />
                <StatCard
                  label="Cents handled"
                  value={`$${(data.autonomy.total_amount_cents_7d / 100).toFixed(2)}`}
                />
                <StatCard
                  label="Committed / total"
                  value={`${data.autonomy.by_outcome.committed ?? 0} / ${data.autonomy.total_7d}`}
                />
              </div>
              {Object.keys(data.autonomy.by_outcome).length > 0 ? (
                <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low mb-2">
                    Outcomes
                  </div>
                  <Histogram map={data.autonomy.by_outcome} />
                </div>
              ) : null}
            </section>

            {/* ─── Pattern detector ─────────────────────────────── */}
            <section className="space-y-3">
              <h2 className="text-[15px] font-semibold text-lumo-fg">Pattern detector (7d)</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <StatCard
                  label="Active patterns"
                  value={String(data.patterns.active_rows_7d)}
                />
                <StatCard
                  label="Distinct users"
                  value={String(data.patterns.distinct_users_7d)}
                />
                <StatCard
                  label="Avg confidence"
                  value={
                    data.patterns.avg_confidence == null
                      ? "—"
                      : data.patterns.avg_confidence.toFixed(2)
                  }
                />
              </div>
            </section>

            {/* ─── Notifications ────────────────────────────────── */}
            <section className="space-y-3">
              <h2 className="text-[15px] font-semibold text-lumo-fg">Notifications</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <StatCard
                  label="Delivered (24h)"
                  value={String(data.notifications.delivered_24h)}
                />
                <StatCard
                  label="Delivered (7d)"
                  value={String(data.notifications.delivered_7d)}
                />
                <StatCard
                  label="Unread live"
                  value={String(data.notifications.unread_live)}
                />
              </div>
              {Object.keys(data.notifications.by_kind_7d).length > 0 ? (
                <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low mb-2">
                    By kind (7d)
                  </div>
                  <Histogram map={data.notifications.by_kind_7d} />
                </div>
              ) : null}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// UI primitives
// ──────────────────────────────────────────────────────────────────────────

function CronCard({ c }: { c: CronHealthRow }) {
  // Health semantics:
  //   red   — last run failed OR no run in the last hour (when we expect /15)
  //   amber — at least one failure in the last 24h
  //   green — all clear
  let status: "red" | "amber" | "green" = "green";
  const now = Date.now();
  const last = c.last_run_at ? new Date(c.last_run_at).getTime() : 0;
  const ageMs = last ? now - last : Number.POSITIVE_INFINITY;

  // proactive-scan + evaluate-intents run every 15 min; detect-patterns is
  // once nightly. Adjust the "stale" threshold per endpoint.
  const staleBudgetMs = c.endpoint.includes("detect-patterns")
    ? 28 * 60 * 60 * 1000 // 28h — leave headroom past a daily tick
    : 30 * 60 * 1000;     // 30m — tolerate one missed 15m tick

  if (c.last_ok === false || ageMs > staleBudgetMs) status = "red";
  else if (c.failures_24h > 0) status = "amber";

  const statusColor = {
    red: "bg-red-500",
    amber: "bg-yellow-500",
    green: "bg-lumo-ok",
  }[status];

  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`h-2 w-2 rounded-full ${statusColor}`} />
        <span className="text-[12.5px] font-mono text-lumo-fg truncate">
          {c.endpoint.replace("/api/cron/", "")}
        </span>
      </div>
      <div className="text-[11.5px] text-lumo-fg-mid">
        {c.last_run_at
          ? `Last ran ${ago(c.last_run_at)} · ${c.last_latency_ms}ms`
          : "Never run"}
      </div>
      <div className="text-[11.5px] text-lumo-fg-low">
        {c.runs_24h} runs / {c.failures_24h} failed (24h)
      </div>
      {c.last_counts && Object.keys(c.last_counts).length > 0 ? (
        <div className="text-[11px] text-lumo-fg-mid font-mono">
          {Object.entries(c.last_counts)
            .map(([k, v]) => `${k}=${v}`)
            .join(" · ")}
        </div>
      ) : null}
      {c.last_errors && c.last_errors.length > 0 ? (
        <div className="text-[11px] text-red-500 break-words">
          {c.last_errors[0]}
          {c.last_errors.length > 1 ? ` (+${c.last_errors.length - 1})` : ""}
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4">
      <div className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
        {label}
      </div>
      <div className="mt-1 text-[22px] font-semibold text-lumo-fg tabular-nums">
        {value}
      </div>
    </div>
  );
}

function Histogram({ map }: { map: Record<string, number> }) {
  const total = Object.values(map).reduce((a, b) => a + b, 0);
  if (total === 0) return <div className="text-[12px] text-lumo-fg-low">No data.</div>;
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return (
    <ul className="space-y-1.5">
      {entries.map(([k, v]) => (
        <li key={k} className="flex items-center gap-3">
          <span className="text-[12px] text-lumo-fg w-36 truncate">{k}</span>
          <div className="flex-1 h-1.5 rounded-full bg-lumo-elevated overflow-hidden">
            <div
              className="h-full bg-lumo-accent"
              style={{ width: `${(v / total) * 100}%` }}
            />
          </div>
          <span className="text-[11.5px] font-mono text-lumo-fg-mid w-12 text-right">
            {v}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
