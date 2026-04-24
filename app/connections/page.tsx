"use client";

/**
 * /connections — the user's list of connected apps.
 *
 * Shows every agent_connections row for the current user with status,
 * scopes granted, last used, and a Disconnect button. Revoked/expired
 * rows are shown grayed out as history.
 *
 * Middleware gates access.
 *
 * Suspense wrap: useSearchParams() below forces CSR and Next 14 refuses
 * to prerender without a Suspense boundary above the hook consumer.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface ConnectionMeta {
  id: string;
  agent_id: string;
  status: "active" | "expired" | "revoked" | "error";
  scopes: string[];
  expires_at: string | null;
  connected_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  updated_at: string;
}

interface MarketplaceAgent {
  agent_id: string;
  display_name: string;
  one_liner: string;
  listing?: {
    logo_url?: string;
    category?: string;
  } | null;
}

export default function ConnectionsPage() {
  return (
    <Suspense fallback={<ConnectionsShell />}>
      <ConnectionsInner />
    </Suspense>
  );
}

function ConnectionsShell() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <div className="mx-auto w-full max-w-3xl px-5 py-8">
        <h1 className="text-[26px] font-semibold tracking-[-0.022em] text-lumo-fg mb-3">
          Your connected apps
        </h1>
        <div className="h-40 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
      </div>
    </main>
  );
}

function ConnectionsInner() {
  const [connections, setConnections] = useState<ConnectionMeta[] | null>(null);
  const [agentsById, setAgentsById] = useState<Record<string, MarketplaceAgent>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sp = useSearchParams();
  const justConnected = sp.get("connected") === "1";
  const errorParam = sp.get("error");

  const load = useCallback(async () => {
    const [connRes, marketRes] = await Promise.all([
      fetch("/api/connections", { cache: "no-store" }),
      fetch("/api/marketplace", { cache: "no-store" }),
    ]);
    if (connRes.ok) {
      const data = (await connRes.json()) as { connections: ConnectionMeta[] };
      setConnections(data.connections);
    } else {
      setError("Couldn't load your connections.");
    }
    if (marketRes.ok) {
      const data = (await marketRes.json()) as { agents: MarketplaceAgent[] };
      setAgentsById(Object.fromEntries(data.agents.map((a) => [a.agent_id, a])));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = useCallback(
    async (connection_id: string) => {
      setBusy(connection_id);
      setError(null);
      try {
        const res = await fetch("/api/connections/disconnect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connection_id }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const active = (connections ?? []).filter((c) => c.status === "active");
  const history = (connections ?? []).filter((c) => c.status !== "active");

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5 hover:text-lumo-accent transition-colors">
              <BrandMark size={22} className="text-lumo-fg" />
              <span className="text-[14px] font-semibold tracking-tight text-lumo-fg">
                Lumo
              </span>
            </Link>
            <span className="text-lumo-fg-low text-[12px]">/</span>
            <span className="text-[13px] text-lumo-fg">Connections</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Link
              href="/marketplace"
              className="h-7 px-2.5 rounded-md inline-flex items-center text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              Marketplace
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] font-semibold tracking-[-0.022em] text-lumo-fg">
            Your connected apps
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid">
            Lumo uses these to act on your behalf. Disconnect any app to revoke access.
          </p>
        </div>

        {justConnected ? (
          <div className="rounded-md border border-lumo-ok/30 bg-lumo-ok/5 px-3 py-2 text-[12.5px] text-lumo-ok">
            Connected. You&apos;re good to go.
          </div>
        ) : null}
        {errorParam ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            Something went wrong: {decodeURIComponent(errorParam)}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            {error}
          </div>
        ) : null}

        {!connections ? (
          <div className="text-[13px] text-lumo-fg-mid py-10">Loading…</div>
        ) : active.length === 0 ? (
          <div className="rounded-xl border border-dashed border-lumo-hair p-8 text-center space-y-3">
            <div className="text-[14px] text-lumo-fg">No apps connected yet.</div>
            <p className="text-[12.5px] text-lumo-fg-mid max-w-sm mx-auto">
              Visit the marketplace to connect your first app.
            </p>
            <Link
              href="/marketplace"
              className="inline-block h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors"
            >
              Browse the marketplace
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {active.map((c) => {
              const a = agentsById[c.agent_id];
              return (
                <li
                  key={c.id}
                  className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 flex items-start gap-4"
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="text-[14px] font-semibold text-lumo-fg truncate">
                        {a?.display_name ?? c.agent_id}
                      </div>
                      <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-lumo-ok border border-lumo-ok/30 bg-lumo-ok/10 rounded px-1.5 py-0.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-lumo-ok" />
                        Active
                      </span>
                    </div>
                    <div className="text-[12px] text-lumo-fg-mid">
                      Connected {relativeTime(c.connected_at)}
                      {c.last_used_at ? ` · Last used ${relativeTime(c.last_used_at)}` : ""}
                    </div>
                    {c.scopes.length > 0 ? (
                      <div className="text-[11.5px] text-lumo-fg-low">
                        Scopes: {c.scopes.join(", ")}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => void disconnect(c.id)}
                    disabled={busy === c.id}
                    className="h-7 px-3 rounded-md border border-lumo-hair text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge disabled:opacity-60 transition-colors"
                  >
                    {busy === c.id ? "Disconnecting…" : "Disconnect"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {history.length > 0 ? (
          <details className="pt-4 border-t border-lumo-hair">
            <summary className="cursor-pointer text-[12px] text-lumo-fg-low hover:text-lumo-fg-mid">
              Previous connections ({history.length})
            </summary>
            <ul className="mt-3 space-y-1.5">
              {history.map((c) => {
                const a = agentsById[c.agent_id];
                return (
                  <li
                    key={c.id}
                    className="flex items-center justify-between text-[12px] text-lumo-fg-low"
                  >
                    <span>
                      {a?.display_name ?? c.agent_id}{" "}
                      <span className="text-lumo-fg-low">· {c.status}</span>
                    </span>
                    <span>{relativeTime(c.updated_at ?? c.revoked_at ?? c.connected_at)}</span>
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </div>
    </main>
  );
}

function relativeTime(isoString: string | null): string {
  if (!isoString) return "";
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(isoString).toLocaleDateString();
}

