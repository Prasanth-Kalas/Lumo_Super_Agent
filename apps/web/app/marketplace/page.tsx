"use client";

/**
 * /marketplace — catalog of agents the Super Agent can orchestrate.
 *
 * Renders a grid of AgentCards keyed off /api/marketplace. The Connect
 * button kicks off an OAuth round-trip by POSTing to
 * /api/connections/start and navigating to the returned authorize_url.
 *
 * The catalog is public. Connect/install actions stay auth-gated by
 * their API routes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AgentCard } from "@/components/AgentCard";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import McpConnectModal from "@/components/McpConnectModal";
import {
  marketplaceAgentMatchesQuery,
  marketplaceAgentMatchesSegment,
  marketplaceCounts,
  marketplaceSegmentLabel,
  sortMarketplaceAgents,
  type MarketplaceSegment,
} from "@/lib/marketplace-ui";

interface MarketplaceAgent {
  agent_id: string;
  display_name: string;
  one_liner: string;
  domain: string;
  version: string;
  intents: string[];
  listing: {
    logo_url?: string;
    category?: string;
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
  /** "lumo" for native agents, "mcp" for MCP-backed, "coming_soon" for placeholders. */
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

export default function MarketplacePage() {
  const [agents, setAgents] = useState<MarketplaceAgent[] | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [segment, setSegment] = useState<MarketplaceSegment>("all");
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpModalFor, setMcpModalFor] = useState<MarketplaceAgent | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<MarketplaceAgent | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Re-fetch the catalog after a successful connect so the UI
  // flips to "Connected" without a manual refresh.
  const refreshCatalog = useCallback(async () => {
    try {
      const res = await fetch("/api/marketplace", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { agents: MarketplaceAgent[] };
      setAgents(data.agents);
    } catch {
      /* ignore — the stale list is fine */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/marketplace", { cache: "no-store" });
        if (!alive) return;
        if (!res.ok) {
          setError("Couldn't load the catalog.");
          return;
        }
        const data = (await res.json()) as { agents: MarketplaceAgent[] };
        setAgents(data.agents);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const categories = useMemo(() => {
    if (!agents) return [] as string[];
    const set = new Set<string>();
    for (const a of agents) {
      if (a.listing?.category) set.add(a.listing.category);
    }
    return ["all", ...Array.from(set).sort()];
  }, [agents]);

  const sortedAgents = useMemo(() => {
    if (!agents) return [];
    return sortMarketplaceAgents(agents);
  }, [agents]);

  const counts = useMemo(() => marketplaceCounts(agents ?? []), [agents]);

  const filtered = useMemo(() => {
    return sortedAgents.filter((agent) => {
      const categoryMatches = filter === "all" || agent.listing?.category === filter;
      return (
        categoryMatches &&
        marketplaceAgentMatchesSegment(agent, segment) &&
        marketplaceAgentMatchesQuery(agent, query)
      );
    });
  }, [filter, query, segment, sortedAgents]);

  const availableAgents = useMemo(
    () => filtered.filter((a) => a.source !== "coming_soon"),
    [filtered],
  );
  const upcomingAgents = useMemo(
    () => filtered.filter((a) => a.source === "coming_soon"),
    [filtered],
  );

  // Featured hero — prefers an installed agent so returning users see
  // their own space first; falls back to the first available card.
  // Mirrors `MarketplaceUI.featured(from:)` on iOS.
  const featuredAgent = useMemo<MarketplaceAgent | null>(() => {
    if (availableAgents.length === 0) return null;
    return (
      availableAgents.find(
        (a) => a.install?.status === "installed" || a.connection?.status === "active",
      ) ?? availableAgents[0] ?? null
    );
  }, [availableAgents]);

  const startConnect = useCallback(
    async (agent: MarketplaceAgent) => {
      if (connecting) return;

      // MCP servers with bearer-token auth get the token-paste
      // modal. OAuth for MCP lands in Phase 1c; until then bearer
      // is the only MCP connect model we actually support.
      if (agent.source === "mcp") {
        if (agent.connect_model === "mcp_bearer") {
          setMcpModalFor(agent);
          return;
        }
        // "mcp_none" public servers — nothing to connect.
        return;
      }

      setConnecting(agent.agent_id);
      setError(null);
      try {
        const res = await fetch("/api/connections/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent_id: agent.agent_id,
            redirect_after: `${pathname}?connected=${agent.agent_id}`,
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
        setConnecting(null);
      }
    },
    [connecting, pathname],
  );

  const toggleInstall = useCallback(
    async (agent: MarketplaceAgent) => {
      if (connecting) return;
      const installed = agent.install?.status === "installed";
      if (!installed) {
        router.push(`/agents/${encodeURIComponent(agent.agent_id)}/install`);
        return;
      }
      setPendingUninstall(agent);
    },
    [connecting, router],
  );

  const confirmUninstall = useCallback(
    async () => {
      const agent = pendingUninstall;
      if (!agent || connecting) return;
      setConnecting(agent.agent_id);
      setError(null);
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agent.agent_id)}/install`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
        });
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          throw new Error(j?.detail ?? j?.error ?? `HTTP ${res.status}`);
        }
        setPendingUninstall(null);
        await refreshCatalog();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setConnecting(null);
      }
    },
    [connecting, pendingUninstall, refreshCatalog],
  );

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center hover:opacity-90 transition-opacity">
              <LumoWordmark height={20} />
            </Link>
            <span className="text-lumo-fg-low text-[12px]">/</span>
            <span className="text-[13px] text-lumo-fg">Marketplace</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Link
              href="/connections"
              className="h-7 px-2.5 rounded-md inline-flex items-center text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              My connections
            </Link>
            <Link
              href="/"
              className="h-7 px-2.5 rounded-md inline-flex items-center text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              Chat
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-5 py-8">
        <div className="mb-6 space-y-2">
          <h1 className="text-[28px] font-semibold tracking-[-0.022em] text-lumo-fg">
            Apps for Lumo
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid max-w-2xl">
            Connect the services Lumo can use from chat. Available apps are
            shown first; review-only integrations stay tucked below.
          </p>
        </div>

        <section className="mb-5 grid gap-3 sm:grid-cols-4">
          <MarketplaceStat label="Total apps" value={counts.total} />
          <MarketplaceStat label="Connected" value={counts.connected} />
          <MarketplaceStat label="Live apps" value={counts.available} />
          <MarketplaceStat label="Review only" value={counts.review} />
        </section>

        <section className="mb-5 rounded-xl border border-lumo-hair bg-lumo-surface p-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <label className="block">
              <span className="sr-only">Search marketplace apps</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search apps, skills, or services..."
                className="h-9 w-full rounded-lg border border-lumo-hair bg-lumo-bg px-3 text-[13px] text-lumo-fg outline-none transition-colors placeholder:text-lumo-fg-low focus:border-lumo-accent"
              />
            </label>
            <div className="flex flex-wrap items-center gap-1">
              {(["all", "connected", "available", "mcp", "review"] as const).map(
                (s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSegment(s)}
                    className={
                      "h-8 rounded-md border px-2.5 text-[12px] transition-colors " +
                      (segment === s
                        ? "border-lumo-fg bg-lumo-fg text-lumo-bg"
                        : "border-lumo-hair text-lumo-fg-mid hover:border-lumo-edge hover:text-lumo-fg")
                    }
                  >
                    {marketplaceSegmentLabel(s)}
                    {s === "mcp" && counts.mcp > 0 ? ` ${counts.mcp}` : ""}
                  </button>
                ),
              )}
            </div>
          </div>
        </section>

        {categories.length > 2 ? (
          <div className="mb-5 flex flex-wrap items-center gap-1.5">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setFilter(c)}
                className={
                  "h-7 px-3 rounded-full text-[12px] border transition-colors " +
                  (filter === c
                    ? "bg-lumo-fg text-lumo-bg border-lumo-fg"
                    : "border-lumo-hair text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge")
                }
              >
                {c === "all" ? "All" : c}
              </button>
            ))}
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            {error}
          </div>
        ) : null}

        {!agents ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-44 animate-pulse rounded-xl border border-lumo-hair bg-lumo-surface"
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-lumo-hair bg-lumo-surface px-4 py-8 text-[13px] text-lumo-fg-mid">
            No apps match this view.
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setFilter("all");
                setSegment("all");
              }}
              className="ml-2 text-lumo-accent hover:underline"
            >
              Reset filters
            </button>
          </div>
        ) : (
          <div className="space-y-10">
            {availableAgents.length >= 3 && featuredAgent ? (
              <FeaturedHero
                agent={featuredAgent}
                onOpen={() => {
                  router.push(`/marketplace/${featuredAgent.agent_id}`);
                }}
              />
            ) : null}

            {availableAgents.length > 0 ? (
              <section>
                <SectionHeading
                  title="Available now"
                  count={availableAgents.length}
                />
                <AgentGrid
                  agents={availableAgents}
                  connecting={connecting}
                  onStartConnect={startConnect}
                  onToggleInstall={toggleInstall}
                />
              </section>
            ) : filter === "all" ? (
              <div className="rounded-xl border border-lumo-hair bg-lumo-surface px-4 py-5">
                <div className="text-[13.5px] font-medium text-lumo-fg">
                  No connectable apps are online in this dev session.
                </div>
                <div className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-lumo-fg-mid">
                  Start the local agent services or configure the production
                  registry env vars and the live Lumo apps will appear here.
                  Review-only integrations are still shown below.
                </div>
              </div>
            ) : null}

            {upcomingAgents.length > 0 ? (
              <section>
                <SectionHeading
                  title="Coming soon"
                  count={upcomingAgents.length}
                />
                <AgentGrid
                  agents={upcomingAgents}
                  connecting={connecting}
                  onStartConnect={startConnect}
                  onToggleInstall={toggleInstall}
                />
              </section>
            ) : null}
          </div>
        )}

        <div className="mt-10 text-[12px] text-lumo-fg-low">
          Are you building an app? <Link href="/publisher" className="text-lumo-accent hover:underline">Publish it on Lumo</Link> (coming soon).
        </div>
      </div>

      <McpConnectModal
        open={mcpModalFor !== null}
        server={
          mcpModalFor
            ? {
                server_id: mcpModalFor.agent_id.replace(/^mcp:/, ""),
                display_name: mcpModalFor.display_name,
                one_liner: mcpModalFor.one_liner,
                scopes: mcpModalFor.required_scopes,
              }
            : null
        }
        onClose={() => setMcpModalFor(null)}
        onConnected={() => {
          void refreshCatalog();
        }}
      />
      {pendingUninstall ? (
        <UninstallDialog
          agent={pendingUninstall}
          busy={connecting === pendingUninstall.agent_id}
          onCancel={() => setPendingUninstall(null)}
          onConfirm={() => void confirmUninstall()}
        />
      ) : null}
    </main>
  );
}

function UninstallDialog({
  agent,
  busy,
  onCancel,
  onConfirm,
}: {
  agent: MarketplaceAgent;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="marketplace-uninstall-title"
        className="w-full max-w-sm rounded-xl border border-lumo-hair bg-lumo-bg p-4 shadow-xl"
      >
        <h2 id="marketplace-uninstall-title" className="text-[15px] font-semibold text-lumo-fg">
          Remove {agent.display_name}?
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-lumo-fg-mid">
          Lumo will stop using this app in chat and its active permission grants
          will be revoked. You can install it again later.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-8 rounded-md border border-lumo-hair px-3 text-[12.5px] text-lumo-fg-mid transition-colors hover:border-lumo-edge hover:text-lumo-fg disabled:opacity-60"
          >
            Keep installed
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="h-8 rounded-md bg-lumo-fg px-3 text-[12.5px] font-medium text-lumo-bg transition-colors hover:bg-lumo-err hover:text-white disabled:opacity-60"
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MarketplaceStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-lumo-hair bg-lumo-surface px-3 py-2.5">
      <div className="text-[20px] font-semibold tracking-[-0.02em] text-lumo-fg">
        {value}
      </div>
      <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low">
        {label}
      </div>
    </div>
  );
}

/**
 * App Store-style hero for the top of the catalog. Renders larger
 * than a normal AgentCard with a tinted gradient background and a
 * prominent CTA. Tapping anywhere navigates to the agent detail.
 */
function FeaturedHero({
  agent,
  onOpen,
}: {
  agent: MarketplaceAgent;
  onOpen: () => void;
}) {
  const tone = featuredTone(agent.agent_id);
  const initial = agent.display_name.trim().charAt(0).toUpperCase();
  const installed =
    agent.install?.status === "installed" ||
    agent.connection?.status === "active";
  return (
    <section>
      <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-lumo-fg-low">
        Featured
      </h2>
      <button
        type="button"
        onClick={onOpen}
        className="group block w-full overflow-hidden rounded-3xl border border-lumo-hair bg-lumo-surface p-6 text-left transition-all hover:border-lumo-edge hover:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.3)] focus:outline-none focus:ring-2 focus:ring-lumo-accent sm:p-8"
        style={{
          backgroundImage: `linear-gradient(135deg, ${tone.bgFrom} 0%, ${tone.bgTo} 100%)`,
        }}
      >
        <div className="flex items-start gap-5 sm:gap-6">
          {agent.listing?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={agent.listing.logo_url}
              alt={agent.display_name}
              className="h-24 w-24 shrink-0 rounded-3xl border border-white/30 bg-white/10 object-cover shadow-lg"
            />
          ) : (
            <div
              className="flex h-24 w-24 shrink-0 items-center justify-center rounded-3xl text-[44px] font-semibold text-white shadow-lg"
              style={{
                backgroundImage: `linear-gradient(135deg, ${tone.iconFrom} 0%, ${tone.iconTo} 100%)`,
              }}
              aria-hidden
            >
              {initial}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-lumo-fg-mid">
              {agent.listing?.category ?? "Featured"}
            </div>
            <div className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-lumo-fg sm:text-[32px]">
              {agent.display_name}
            </div>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-lumo-fg-mid">
              {agent.one_liner}
            </p>
            <div className="mt-4 inline-flex items-center gap-2">
              <span
                className={
                  "inline-flex h-9 items-center rounded-full px-5 text-[13px] font-semibold tracking-[0.02em] transition-colors " +
                  (installed
                    ? "bg-lumo-elevated text-lumo-accent group-hover:bg-lumo-elevated/80"
                    : "bg-lumo-fg text-lumo-bg group-hover:bg-lumo-accent group-hover:text-lumo-accent-ink")
                }
              >
                {installed ? "OPEN" : "VIEW"}
              </span>
            </div>
          </div>
        </div>
      </button>
    </section>
  );
}

function featuredTone(agentID: string): {
  bgFrom: string;
  bgTo: string;
  iconFrom: string;
  iconTo: string;
} {
  // Subtle, brand-aligned gradient palette — hashed off agent_id so
  // the same agent always lands on the same hero tint across renders.
  const palette = [
    {
      bgFrom: "rgba(56, 189, 248, 0.12)",
      bgTo: "rgba(99, 102, 241, 0.06)",
      iconFrom: "rgb(56, 189, 248)",
      iconTo: "rgb(99, 102, 241)",
    },
    {
      bgFrom: "rgba(167, 139, 250, 0.12)",
      bgTo: "rgba(236, 72, 153, 0.06)",
      iconFrom: "rgb(167, 139, 250)",
      iconTo: "rgb(236, 72, 153)",
    },
    {
      bgFrom: "rgba(52, 211, 153, 0.12)",
      bgTo: "rgba(20, 184, 166, 0.06)",
      iconFrom: "rgb(52, 211, 153)",
      iconTo: "rgb(20, 184, 166)",
    },
    {
      bgFrom: "rgba(251, 191, 36, 0.12)",
      bgTo: "rgba(249, 115, 22, 0.06)",
      iconFrom: "rgb(251, 191, 36)",
      iconTo: "rgb(249, 115, 22)",
    },
  ];
  let h = 0;
  for (let i = 0; i < agentID.length; i++) {
    h = (h * 31 + agentID.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(h) % palette.length] ?? palette[0]!;
}

function SectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-lumo-fg-low">
        {title}
      </h2>
      <span className="rounded-full border border-lumo-hair px-2 py-0.5 text-[11px] text-lumo-fg-low">
        {count}
      </span>
    </div>
  );
}

function AgentGrid({
  agents,
  connecting,
  onStartConnect,
  onToggleInstall,
}: {
  agents: MarketplaceAgent[];
  connecting: string | null;
  onStartConnect: (agent: MarketplaceAgent) => Promise<void>;
  onToggleInstall: (agent: MarketplaceAgent) => Promise<void>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((a) => (
        <AgentCard
          key={a.agent_id}
          agent_id={a.agent_id}
          display_name={a.display_name}
          one_liner={a.one_liner}
          category={a.listing?.category ?? null}
          logo_url={a.listing?.logo_url ?? null}
          pricing_note={a.listing?.pricing_note ?? null}
          connected={
            a.connection?.status === "active" ||
            a.install?.status === "installed"
          }
          status_label={
            a.connection?.status === "active" ? "Connected" : "Installed"
          }
          connecting={connecting === a.agent_id}
          action_label={
            a.connect_model === "none"
              ? a.install?.status === "installed"
                ? "Remove"
                : "Install"
              : undefined
          }
          source={a.source}
          coming_soon_label={a.coming_soon?.eta_label}
          coming_soon_rationale={a.coming_soon?.rationale}
          onConnect={
            a.source === "coming_soon"
              ? undefined
              : a.connect_model === "none" && a.source !== "mcp"
                ? () => void onToggleInstall(a)
                : a.connect_model === "oauth2" ||
                    a.connect_model === "mcp_bearer"
                  ? () => void onStartConnect(a)
                  : undefined
          }
          linkToDetail={a.source !== "mcp"}
        />
      ))}
    </div>
  );
}
