"use client";

/**
 * /marketplace — catalog of agents the Super Agent can orchestrate.
 *
 * Renders a grid of AgentCards keyed off /api/marketplace. The Connect
 * button kicks off an OAuth round-trip by POSTing to
 * /api/connections/start and navigating to the returned authorize_url.
 *
 * Middleware guarantees the user is authenticated.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AgentCard } from "@/components/AgentCard";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import McpConnectModal from "@/components/McpConnectModal";

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
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpModalFor, setMcpModalFor] = useState<MarketplaceAgent | null>(null);
  const pathname = usePathname();

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

  const filtered = useMemo(() => {
    if (!agents) return [];
    if (filter === "all") return agents;
    return agents.filter((a) => a.listing?.category === filter);
  }, [agents, filter]);

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
      setConnecting(agent.agent_id);
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
        await refreshCatalog();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setConnecting(null);
      }
    },
    [connecting, refreshCatalog],
  );

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5 hover:text-lumo-accent transition-colors">
              <BrandMark size={22} className="text-lumo-fg" />
              <span className="text-[14px] font-semibold tracking-tight text-lumo-fg">
                Lumo
              </span>
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
            The Lumo Appstore
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid max-w-2xl">
            Connect the apps you already use. Lumo orchestrates them from a
            single chat — flights, food, hotels, whatever lives here next.
          </p>
        </div>

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
          <div className="text-[13px] text-lumo-fg-mid py-10">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-[13px] text-lumo-fg-mid py-10">
            No apps in this category yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((a) => (
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
                risk_badge={a.risk_badge}
                onConnect={
                  a.source === "coming_soon"
                    ? undefined
                    : a.connect_model === "none" && a.source !== "mcp"
                    ? () => void toggleInstall(a)
                    : a.connect_model === "oauth2" ||
                        a.connect_model === "mcp_bearer"
                      ? () => void startConnect(a)
                      : undefined
                }
                linkToDetail={a.source !== "mcp"}
              />
            ))}
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
    </main>
  );
}
