"use client";

/**
 * /marketplace/[agent_id] — agent detail page.
 *
 * Shows the full marketing stack (hero, about, category, scopes, links),
 * plus a prominent Connect CTA. If already connected, shows Manage
 * (disconnect) and a "Last used" line.
 *
 * Reuses /api/marketplace as the source of truth; the detail is picked
 * from the list by agent_id. For a catalog of thousands we'd add a
 * single-agent endpoint, but we're nowhere near that.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface MarketplaceAgent {
  agent_id: string;
  display_name: string;
  one_liner: string;
  domain: string;
  version: string;
  intents: string[];
  listing: {
    logo_url?: string;
    hero_url?: string;
    category?: string;
    about_paragraphs?: string[];
    homepage_url?: string;
    privacy_policy_url?: string;
    terms_url?: string;
    pricing_note?: string;
  } | null;
  connect_model:
    | "oauth2"
    | "lumo_id"
    | "none"
    | "mcp_bearer"
    | "mcp_none"
    | "coming_soon";
  required_scopes: Array<{ name: string; description: string }>;
  health_score: number;
  source?: "lumo" | "mcp" | "coming_soon";
  coming_soon?: {
    status: "in_review" | "planned";
    eta_label: string;
    rationale: string;
  };
  connection: {
    id: string;
    status: "active" | "expired" | "revoked" | "error";
    connected_at: string;
    last_used_at: string | null;
  } | null;
  install: {
    status: "installed" | "suspended" | "revoked";
    installed_at: string;
    last_used_at: string | null;
  } | null;
  risk_badge: {
    level: "low" | "medium" | "high" | "review_required";
    score: number;
    reasons: string[];
    mitigations: string[];
    source: "ml" | "fallback";
    latency_ms: number;
    error?: string;
  };
}

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const sp = useSearchParams();
  const agent_id = String(params?.agent_id ?? "");

  const [agent, setAgent] = useState<MarketplaceAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const justConnected = sp.get("connected") === agent_id;

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/marketplace", { cache: "no-store" });
        if (!alive) return;
        if (!res.ok) {
          setError("Couldn't load the catalog.");
          return;
        }
        const data = (await res.json()) as { agents: MarketplaceAgent[] };
        const found = data.agents.find((a) => a.agent_id === agent_id) ?? null;
        setAgent(found);
        if (!found) setError("No such agent.");
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [agent_id]);

  const startConnect = useCallback(async () => {
    if (!agent || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/connections/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: agent.agent_id,
          redirect_after: `/marketplace/${agent.agent_id}?connected=${agent.agent_id}`,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.detail ?? j?.error ?? `HTTP ${res.status}`);
      }
      const { authorize_url } = (await res.json()) as { authorize_url: string };
      window.location.href = authorize_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConnecting(false);
    }
  }, [agent, connecting]);

  const disconnect = useCallback(async () => {
    if (!agent?.connection) return;
    const res = await fetch("/api/connections/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connection_id: agent.connection.id }),
    });
    if (res.ok) {
      router.refresh();
      // Refetch locally too so the UI flips without a full reload.
      const fresh = await fetch("/api/marketplace", { cache: "no-store" });
      if (fresh.ok) {
        const data = (await fresh.json()) as { agents: MarketplaceAgent[] };
        const found = data.agents.find((a) => a.agent_id === agent_id) ?? null;
        setAgent(found);
      }
    }
  }, [agent, agent_id, router]);

  const toggleInstall = useCallback(async () => {
    if (!agent || connecting) return;
    setConnecting(true);
    setError(null);
    const installed = agent.install?.status === "installed";
    try {
      const res = await fetch("/api/apps/install", {
        method: installed ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: agent.agent_id }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.detail ?? j?.error ?? `HTTP ${res.status}`);
      }
      const fresh = await fetch("/api/marketplace", { cache: "no-store" });
      if (fresh.ok) {
        const data = (await fresh.json()) as { agents: MarketplaceAgent[] };
        const found = data.agents.find((a) => a.agent_id === agent_id) ?? null;
        setAgent(found);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [agent, agent_id, connecting]);

  const isConnected = agent?.connection?.status === "active";
  const isInstalled = agent?.install?.status === "installed";

  if (loading) {
    return (
      <main className="min-h-dvh bg-lumo-bg text-lumo-fg-mid flex items-center justify-center">
        Loading…
      </main>
    );
  }
  if (!agent) {
    return (
      <main className="min-h-dvh bg-lumo-bg text-lumo-fg-mid flex items-center justify-center">
        {error ?? "Agent not found."}
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-3">
            <Link href="/marketplace" className="flex items-center gap-2.5 hover:text-lumo-accent transition-colors">
              <BrandMark size={22} className="text-lumo-fg" />
              <span className="text-[14px] font-semibold tracking-tight text-lumo-fg">
                Lumo
              </span>
              <span className="text-lumo-fg-low text-[12px]">/</span>
              <span className="text-[13px] text-lumo-fg-mid">Marketplace</span>
            </Link>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-5 py-8 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
        <div className="space-y-6">
          <div className="flex items-start gap-4">
            {agent.listing?.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={agent.listing.logo_url}
                alt={agent.display_name}
                className="h-16 w-16 rounded-xl border border-lumo-hair bg-lumo-elevated object-cover"
              />
            ) : (
              <div className="h-16 w-16 rounded-xl border border-lumo-hair bg-lumo-elevated flex items-center justify-center">
                <BrandMark size={28} className="text-lumo-fg-mid" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h1 className="text-[26px] font-semibold tracking-tight text-lumo-fg">
                {agent.display_name}
              </h1>
              <div className="flex items-center gap-2 mt-1">
                {agent.listing?.category ? (
                  <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
                    {agent.listing.category}
                  </span>
                ) : null}
                <span className="text-lumo-fg-low text-[11px]">·</span>
                <span className="text-[11px] text-lumo-fg-low">v{agent.version}</span>
              </div>
              <p className="text-[14px] text-lumo-fg-mid mt-2 max-w-xl">
                {agent.one_liner}
              </p>
            </div>
          </div>

          {justConnected ? (
            <div className="rounded-md border border-lumo-ok/30 bg-lumo-ok/5 px-3 py-2 text-[12.5px] text-lumo-ok">
              Connected. You can now ask Lumo to use {agent.display_name}.
            </div>
          ) : null}

          {agent.listing?.about_paragraphs?.length ? (
            <section className="space-y-3">
              <h2 className="text-[15px] font-semibold text-lumo-fg">About</h2>
              <div className="space-y-3 text-[13.5px] text-lumo-fg-mid leading-relaxed">
                {agent.listing.about_paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </section>
          ) : null}

          <section className="space-y-3">
            <h2 className="text-[15px] font-semibold text-lumo-fg">What it can do</h2>
            <ul className="space-y-1.5 text-[13px] text-lumo-fg-mid">
              {agent.intents.map((i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-lumo-accent mt-1">›</span>
                  <span>{humanizeIntent(i)}</span>
                </li>
              ))}
            </ul>
          </section>

          {agent.required_scopes.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-[15px] font-semibold text-lumo-fg">
                When you connect, Lumo will be able to:
              </h2>
              <ul className="space-y-1.5 text-[13px] text-lumo-fg-mid">
                {agent.required_scopes.map((s) => (
                  <li key={s.name} className="flex items-start gap-2">
                    <span className="text-lumo-fg-low mt-1">•</span>
                    <span>
                      <span className="text-lumo-fg">{s.description}</span>
                      <span className="ml-2 text-[11px] text-lumo-fg-low">
                        ({s.name})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11.5px] text-lumo-fg-low">
                Lumo only accesses {agent.display_name} with your active session. You can disconnect at any time from the Connections page.
              </p>
            </section>
          ) : null}
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[12px] font-medium text-lumo-fg">Permission risk</div>
              <RiskBadge badge={agent.risk_badge} />
            </div>
            <div className="text-[12px] leading-relaxed text-lumo-fg-mid">
              {agent.risk_badge.reasons[0] ?? "No sensitive required scopes detected"}
            </div>
            {agent.risk_badge.level !== "low" ? (
              <ul className="space-y-1 text-[11.5px] leading-relaxed text-lumo-fg-low">
                {agent.risk_badge.mitigations.slice(0, 2).map((mitigation) => (
                  <li key={mitigation}>{mitigation}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-3">
            {isConnected ? (
              <>
                <div className="text-[12.5px] text-lumo-ok flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-lumo-ok" />
                  Connected
                </div>
                <div className="text-[11px] text-lumo-fg-low">
                  {agent.connection?.last_used_at
                    ? `Last used ${relativeTime(agent.connection.last_used_at)}`
                    : `Connected ${relativeTime(agent.connection!.connected_at)}`}
                </div>
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  className="w-full h-8 rounded-md border border-lumo-hair text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge transition-colors"
                >
                  Disconnect
                </button>
              </>
            ) : agent.connect_model === "oauth2" ? (
              <>
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => void startConnect()}
                  className="w-full h-9 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:opacity-60 transition-colors"
                >
                  {connecting ? "Opening…" : `Connect ${agent.display_name}`}
                </button>
                {agent.listing?.pricing_note ? (
                  <div className="text-[11px] text-lumo-fg-low text-center">
                    {agent.listing.pricing_note}
                  </div>
                ) : null}
              </>
            ) : agent.connect_model === "none" ? (
              <>
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => void toggleInstall()}
                  className="w-full h-9 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:opacity-60 transition-colors"
                >
                  {connecting
                    ? "Saving…"
                    : isInstalled
                      ? `Remove ${agent.display_name}`
                      : `Install ${agent.display_name}`}
                </button>
                <div className="text-[11px] text-lumo-fg-low text-center">
                  {isInstalled
                    ? "Installed apps are available to Lumo in chat."
                    : "Install to let Lumo use this app in chat."}
                </div>
              </>
            ) : (
              <div className="text-[12.5px] text-lumo-fg-mid">
                This app doesn&apos;t require a connection.
              </div>
            )}
          </div>

          {(agent.listing?.homepage_url ||
            agent.listing?.privacy_policy_url ||
            agent.listing?.terms_url) && (
            <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-2 text-[12px]">
              {agent.listing?.homepage_url ? (
                <a
                  href={agent.listing.homepage_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-lumo-fg-mid hover:text-lumo-accent transition-colors"
                >
                  Homepage ↗
                </a>
              ) : null}
              {agent.listing?.privacy_policy_url ? (
                <a
                  href={agent.listing.privacy_policy_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-lumo-fg-mid hover:text-lumo-accent transition-colors"
                >
                  Privacy policy ↗
                </a>
              ) : null}
              {agent.listing?.terms_url ? (
                <a
                  href={agent.listing.terms_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-lumo-fg-mid hover:text-lumo-accent transition-colors"
                >
                  Terms of service ↗
                </a>
              ) : null}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function RiskBadge({
  badge,
}: {
  badge: MarketplaceAgent["risk_badge"];
}) {
  const classes =
    badge.level === "low"
      ? "border-lumo-ok/30 bg-lumo-ok/10 text-lumo-ok"
      : badge.level === "medium"
        ? "border-lumo-warn/35 bg-lumo-warn/10 text-lumo-warn"
        : badge.level === "high"
          ? "border-lumo-err/35 bg-lumo-err/10 text-lumo-err"
          : "border-lumo-hair bg-lumo-bg text-lumo-fg-low";
  return (
    <span className={`rounded px-2 py-1 text-[10.5px] uppercase tracking-[0.1em] border ${classes}`}>
      {badge.level === "review_required" ? "review" : `${badge.level} risk`}
    </span>
  );
}

function humanizeIntent(i: string): string {
  return i
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function relativeTime(isoString: string): string {
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
