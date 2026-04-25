"use client";

/**
 * /admin/health — observability hub.
 *
 * Per the chosen scope, Lumo doesn't run its own metrics database
 * yet — health observability is delegated to whichever external
 * monitor the team configures (Datadog, Vercel Analytics, Grafana,
 * Better Stack…). This page is the launchpad: links out to the
 * configured providers, plus a bare on-demand probe row per agent.
 *
 * Configure provider URLs in admin settings under future keys:
 *   monitor.datadog_dashboard_url
 *   monitor.vercel_analytics_url
 *   monitor.grafana_dashboard_url
 * For now we link to known defaults and let the operator click through.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

interface App {
  agent_id: string;
  display_name: string;
  base_url: string | null;
  source: "lumo" | "partner" | "mcp";
  health_score: number | null;
}

export default function AdminHealthPage() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [results, setResults] = useState<
    Map<string, { ok: boolean; latency_ms: number; detail: string }>
  >(new Map());

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/apps", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { apps?: App[] };
        setApps(j.apps ?? []);
      } catch {
        setApps([]);
      }
    })();
  }, []);

  async function probe(app: App) {
    if (!app.base_url) return;
    setProbing(app.agent_id);
    const started = Date.now();
    try {
      const probeUrl = new URL("/api/health", app.base_url).toString();
      const res = await fetch(probeUrl, { cache: "no-store" });
      const latency = Date.now() - started;
      const ok = res.ok;
      const detail = ok ? `${res.status} OK` : `${res.status}`;
      setResults((prev) =>
        new Map(prev).set(app.agent_id, { ok, latency_ms: latency, detail }),
      );
    } catch (e) {
      setResults((prev) =>
        new Map(prev).set(app.agent_id, {
          ok: false,
          latency_ms: Date.now() - started,
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setProbing(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Health</h1>
        <p className="text-[13px] text-lumo-fg-mid">
          Lumo delegates metrics to your existing observability stack.
          Wire up Datadog or Vercel Analytics for charts, latency, error
          rates. The on-demand probe below is for sanity checking a
          specific agent right now.
        </p>
      </div>

      <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-3">
        <h2 className="text-[14px] font-semibold tracking-tight">
          External monitoring
        </h2>
        <p className="text-[12.5px] text-lumo-fg-mid leading-relaxed">
          Open the right dashboard for the question you have. Latency
          and error rate per route live in Vercel Analytics; agent-side
          metrics belong wherever the partner ships logs.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <ExternalCard
            label="Vercel Analytics"
            href="https://vercel.com/prasanthkalas-6046s-projects/lumo-super-agent/analytics"
            sub="Routes, latency, error rate"
          />
          <ExternalCard
            label="Vercel Logs"
            href="https://vercel.com/prasanthkalas-6046s-projects/lumo-super-agent/logs"
            sub="Live runtime logs"
          />
          <ExternalCard
            label="Supabase"
            href="https://supabase.com/dashboard/project/ohtjjusrwxmdvzkuhaxn"
            sub="DB perf, slow queries"
          />
        </div>
      </section>

      <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-3">
        <h2 className="text-[14px] font-semibold tracking-tight">
          On-demand probe
        </h2>
        <p className="text-[12.5px] text-lumo-fg-mid leading-relaxed">
          Hits each agent&apos;s <code className="text-lumo-fg">/api/health</code>{" "}
          from your browser. Useful for verifying an agent is reachable
          right now; not a substitute for continuous monitoring.
        </p>
        {!apps ? (
          <div className="text-[13px] text-lumo-fg-mid py-4">Loading…</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
              <tr className="border-b border-lumo-hair">
                <th className="text-left p-2 font-normal">Agent</th>
                <th className="text-left p-2 font-normal">URL</th>
                <th className="text-right p-2 font-normal">Last probe</th>
                <th className="text-right p-2 font-normal">Action</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => {
                const r = results.get(a.agent_id);
                return (
                  <tr
                    key={a.agent_id}
                    className="border-b border-lumo-hair last:border-0"
                  >
                    <td className="p-2 align-top">
                      <div className="text-lumo-fg">{a.display_name}</div>
                      <div className="text-[11px] text-lumo-fg-low num">
                        {a.agent_id}
                      </div>
                    </td>
                    <td className="p-2 align-top">
                      <div className="text-[11.5px] text-lumo-fg-low truncate max-w-[280px]">
                        {a.base_url ?? "—"}
                      </div>
                    </td>
                    <td className="p-2 align-top text-right">
                      {r ? (
                        <span
                          className={
                            r.ok ? "text-emerald-400" : "text-red-400"
                          }
                        >
                          {r.detail} ·{" "}
                          <span className="num">{r.latency_ms}ms</span>
                        </span>
                      ) : (
                        <span className="text-lumo-fg-low">—</span>
                      )}
                    </td>
                    <td className="p-2 align-top text-right">
                      <button
                        type="button"
                        disabled={!a.base_url || probing === a.agent_id}
                        onClick={() => void probe(a)}
                        className="h-7 px-2.5 rounded-md border border-lumo-hair text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated disabled:opacity-50"
                      >
                        {probing === a.agent_id ? "…" : "Probe"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function ExternalCard({
  label,
  sub,
  href,
}: {
  label: string;
  sub: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-md border border-lumo-hair bg-lumo-bg p-3 hover:border-lumo-edge transition-colors"
    >
      <div className="text-[13px] text-lumo-fg flex items-center justify-between">
        {label}
        <span className="text-lumo-fg-low" aria-hidden>
          ↗
        </span>
      </div>
      <div className="text-[11.5px] text-lumo-fg-low mt-0.5">{sub}</div>
    </Link>
  );
}
