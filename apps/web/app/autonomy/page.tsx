"use client";

/**
 * /autonomy — how much Lumo can do without asking.
 *
 * Three sections:
 *   1. Panic — one-button 24h kill-switch. Always visible, always first.
 *   2. Tiers — per-tool-kind autonomy (always_ask | ask_if_over:$X | auto).
 *   3. Cap — daily spend ceiling + today's usage progress.
 *   4. History — recent autonomous actions (what Lumo did today/yesterday).
 *
 * Middleware gates access.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Autonomy {
  user_id: string;
  tiers: Record<string, string>;
  daily_cap_cents: number;
  kill_switch_until: string | null;
}
interface AutonomousAction {
  id: string;
  intent_id: string | null;
  tool_kind: string;
  tool_name: string;
  agent_id: string | null;
  amount_cents: number;
  currency: string | null;
  outcome: string;
  request_ref: string | null;
  fired_at: string;
}

const TIER_LABELS: Record<string, string> = {
  always_ask: "Always ask",
  auto: "Auto",
};

const KIND_DESCRIPTIONS: Record<string, string> = {
  food_order: "Food delivery orders",
  flight_book: "Flight bookings",
  hotel_book: "Hotel bookings",
  restaurant_reserve: "Restaurant reservations",
  ride_book: "Ride bookings",
};

export default function AutonomyPage() {
  const [data, setData] = useState<{
    autonomy: Autonomy | null;
    spend_today_cents: number;
    recent_actions: AutonomousAction[];
    known_tool_kinds: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/autonomy", { cache: "no-store" });
    if (!res.ok) {
      setError("Couldn't load autonomy settings.");
      return;
    }
    setData(await res.json());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/autonomy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { detail?: string } | null;
        setError(j?.detail ?? "Update failed.");
        return;
      }
      setError(null);
      await load();
    },
    [load],
  );

  const killActive = useMemo(() => {
    if (!data?.autonomy?.kill_switch_until) return false;
    return new Date(data.autonomy.kill_switch_until).getTime() > Date.now();
  }, [data]);

  if (!data) {
    return (
      <main className="min-h-dvh flex items-center justify-center bg-lumo-bg text-lumo-fg-mid">
        {error ?? "Loading…"}
      </main>
    );
  }

  const spent = data.spend_today_cents;
  const cap = data.autonomy?.daily_cap_cents ?? 0;
  const capPct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center hover:opacity-90 transition-opacity">
              <LumoWordmark height={22} />
            </Link>
            <span className="text-lumo-fg-low text-[12px]">/</span>
            <span className="text-[13px] text-lumo-fg">Autonomy</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Link
              href="/intents"
              className="h-7 px-2.5 rounded-md inline-flex items-center text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              Routines
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-8">
        <div className="space-y-2">
          <h1 className="text-[26px] font-semibold tracking-[-0.022em] text-lumo-fg">
            How much can Lumo do without asking?
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid">
            By default Lumo always asks. Open up specific categories once you trust them —
            pause everything in one tap if anything feels off.
          </p>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            {error}
          </div>
        ) : null}

        {/* ─── Panic / kill-switch ─────────────────────────────── */}
        <section
          className={
            "rounded-xl border p-4 " +
            (killActive
              ? "border-red-500/40 bg-red-500/5"
              : "border-lumo-hair bg-lumo-surface")
          }
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-[14px] font-semibold text-lumo-fg">Pause autonomy</h2>
              <p className="text-[12.5px] text-lumo-fg-mid mt-1">
                {killActive
                  ? `Paused until ${new Date(data.autonomy!.kill_switch_until!).toLocaleString()}. Lumo will ask for every action.`
                  : "One tap disables all auto-actions for 24 hours. Lumo still notifies you; you confirm each one."}
              </p>
            </div>
            {killActive ? (
              <button
                type="button"
                onClick={() => void patch({ kill_switch_until: null })}
                className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink"
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void patch({ kill_switch_until: "24h" })}
                className="h-8 px-3 rounded-md border border-red-500/40 text-red-500 text-[12.5px] font-medium hover:bg-red-500/10"
              >
                Pause 24h
              </button>
            )}
          </div>
        </section>

        {/* ─── Tiers ────────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold text-lumo-fg">Per-category tiers</h2>
          <div className="divide-y divide-lumo-hair border-y border-lumo-hair">
            {data.known_tool_kinds.map((kind) => (
              <TierRow
                key={kind}
                kind={kind}
                tier={data.autonomy?.tiers?.[kind] ?? "always_ask"}
                onChange={(t) =>
                  void patch({
                    tiers: { ...(data.autonomy?.tiers ?? {}), [kind]: t },
                  })
                }
              />
            ))}
          </div>
        </section>

        {/* ─── Daily cap ────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold text-lumo-fg">Daily spend cap</h2>
          <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-3">
            <div className="flex items-baseline justify-between">
              <div className="text-[13px] text-lumo-fg">
                Today:{" "}
                <span className="font-mono">{(spent / 100).toFixed(2)}</span>
                <span className="text-lumo-fg-low"> / </span>
                <span className="font-mono">{(cap / 100).toFixed(2)}</span>
              </div>
              <div className="text-[11px] text-lumo-fg-low">UTC day</div>
            </div>
            <div className="h-1.5 rounded-full bg-lumo-elevated overflow-hidden">
              <div
                className="h-full bg-lumo-accent transition-all"
                style={{ width: `${capPct}%` }}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11.5px] text-lumo-fg-low">New cap ($)</label>
              <input
                type="number"
                min={0}
                defaultValue={cap / 100}
                onBlur={(e) => {
                  const v = Math.max(0, Math.floor(Number(e.target.value) * 100));
                  if (v !== cap) void patch({ daily_cap_cents: v });
                }}
                className="w-24 rounded-md border border-lumo-hair bg-lumo-bg px-2 py-1 text-[13px] font-mono text-lumo-fg focus:border-lumo-edge outline-none"
              />
              <span className="text-[11.5px] text-lumo-fg-low">resets at UTC midnight</span>
            </div>
          </div>
        </section>

        {/* ─── History ──────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold text-lumo-fg">What Lumo did for you</h2>
          {data.recent_actions.length === 0 ? (
            <p className="text-[12.5px] text-lumo-fg-mid">
              Nothing yet. When Lumo takes an auto-action it&apos;ll show up here with the
              amount, outcome, and booking reference.
            </p>
          ) : (
            <ul className="divide-y divide-lumo-hair border-y border-lumo-hair">
              {data.recent_actions.map((a) => (
                <li key={a.id} className="py-2.5 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-lumo-fg">
                      {KIND_DESCRIPTIONS[a.tool_kind] ?? a.tool_kind} ·{" "}
                      <span className="font-mono text-lumo-fg-mid">{a.tool_name}</span>
                    </div>
                    <div className="text-[11.5px] text-lumo-fg-low">
                      {new Date(a.fired_at).toLocaleString()}
                      {a.request_ref ? ` · ref ${a.request_ref}` : ""}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[13px] font-mono text-lumo-fg">
                      {(a.amount_cents / 100).toFixed(2)}
                      {a.currency ? ` ${a.currency}` : ""}
                    </div>
                    <div
                      className={
                        "text-[11px] uppercase tracking-wide " +
                        (a.outcome === "committed"
                          ? "text-lumo-ok"
                          : a.outcome === "failed" || a.outcome === "rolled_back"
                            ? "text-red-500"
                            : "text-lumo-fg-mid")
                      }
                    >
                      {a.outcome}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function TierRow({
  kind,
  tier,
  onChange,
}: {
  kind: string;
  tier: string;
  onChange: (t: string) => void;
}) {
  const [mode, setMode] = useState<"always_ask" | "ask_if_over" | "auto">(
    tier === "auto" ? "auto" : tier.startsWith("ask_if_over:") ? "ask_if_over" : "always_ask",
  );
  const [threshold, setThreshold] = useState<number>(
    tier.startsWith("ask_if_over:")
      ? Math.round(parseInt(tier.slice("ask_if_over:".length), 10) / 100)
      : 50,
  );

  useEffect(() => {
    setMode(
      tier === "auto" ? "auto" : tier.startsWith("ask_if_over:") ? "ask_if_over" : "always_ask",
    );
    if (tier.startsWith("ask_if_over:")) {
      setThreshold(Math.round(parseInt(tier.slice("ask_if_over:".length), 10) / 100));
    }
  }, [tier]);

  const commit = (next: { mode?: typeof mode; threshold?: number }) => {
    const m = next.mode ?? mode;
    const t = next.threshold ?? threshold;
    const tierStr =
      m === "auto"
        ? "auto"
        : m === "always_ask"
          ? "always_ask"
          : `ask_if_over:${Math.max(0, Math.floor(t * 100))}`;
    if (tierStr !== tier) onChange(tierStr);
  };

  return (
    <div className="py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] text-lumo-fg">
          {KIND_DESCRIPTIONS[kind] ?? kind}
        </div>
        <div className="text-[11px] text-lumo-fg-low font-mono">{kind}</div>
      </div>
      <select
        value={mode}
        onChange={(e) => {
          const next = e.target.value as typeof mode;
          setMode(next);
          commit({ mode: next });
        }}
        className="h-7 rounded-md border border-lumo-hair bg-lumo-bg px-2 text-[12px] text-lumo-fg focus:border-lumo-edge outline-none"
      >
        <option value="always_ask">Always ask</option>
        <option value="ask_if_over">Ask if over…</option>
        <option value="auto">Auto</option>
      </select>
      {mode === "ask_if_over" ? (
        <div className="flex items-center gap-1">
          <span className="text-[11.5px] text-lumo-fg-low">$</span>
          <input
            type="number"
            min={0}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            onBlur={() => commit({ threshold })}
            className="w-16 rounded-md border border-lumo-hair bg-lumo-bg px-2 py-1 text-[12px] font-mono text-lumo-fg focus:border-lumo-edge outline-none"
          />
        </div>
      ) : null}
    </div>
  );
}
