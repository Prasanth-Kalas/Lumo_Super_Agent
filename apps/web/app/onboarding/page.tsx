"use client";

/**
 * /onboarding — post-signup connector flow.
 *
 * Rendered exactly once per user. Purpose: pair the freshly created
 * account with the upstream services (Gmail, Calendar, Amadeus,
 * OpenTable, etc.) Lumo orchestrates over. The fewer connectors the
 * user starts with, the less Lumo can actually do — so we make
 * connection the default next step after signup, not a buried
 * setting.
 *
 * Rules of the road:
 *   • Skippable — users who want to explore first get a prominent
 *     Skip button. We don't lock them out of the shell.
 *   • Idempotent — if /api/memory reports the user is already
 *     onboarded (extra.onboarded_at present), we redirect to `next`
 *     on mount. That way someone hitting /onboarding by accident
 *     isn't re-asked.
 *   • Progress affordance — a small chip in the top-right showing
 *     "N connected" rises as the user comes back from each OAuth
 *     round-trip. Keeps the momentum visible.
 *   • Continue is always available. Users can connect zero and
 *     proceed; they just get a thinner Lumo.
 *
 * Middleware gates this route behind auth (see middleware.ts
 * PROTECTED_PAGE_PREFIXES). Signed-out visitors land on /login.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentCard } from "@/components/AgentCard";
import { LumoWordmark } from "@/components/BrandMark";
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
  connect_model: "oauth2" | "lumo_id" | "none" | "mcp_bearer" | "mcp_none";
  required_scopes: Array<{ name: string; description: string }>;
  health_score: number;
  source?: "lumo" | "mcp";
  connection: {
    id: string;
    status: "active" | "expired" | "revoked" | "error";
    connected_at: string;
    last_used_at: string | null;
  } | null;
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<OnboardingShell />}>
      <OnboardingFlow />
    </Suspense>
  );
}

/**
 * Shell shown during SSR prerender and while the dynamic bits hydrate.
 * Matches the final layout so there's no visible jump.
 */
function OnboardingShell() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/80 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center">
            <LumoWordmark height={22} />
          </div>
          <ThemeToggle />
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl px-5 py-10">
        <div className="h-8 w-60 rounded bg-lumo-elevated animate-pulse" />
        <div className="mt-3 h-5 w-96 rounded bg-lumo-elevated animate-pulse" />
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-36 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse"
            />
          ))}
        </div>
      </div>
    </main>
  );
}

function OnboardingFlow() {
  const router = useRouter();
  const params = useSearchParams();
  // `next` is the URL the user was trying to reach when signup pushed
  // them through here (passed from signup → /onboarding?next=...).
  // Defaults to the chat shell.
  const next = params.get("next") ?? "/";

  const [agents, setAgents] = useState<MarketplaceAgent[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedOnboarded, setCheckedOnboarded] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [mcpModalFor, setMcpModalFor] = useState<MarketplaceAgent | null>(null);

  // Refetch the catalog after a successful MCP connect so the
  // card flips to "Connected" without reloading the page.
  const refreshCatalog = useCallback(async () => {
    try {
      const res = await fetch("/api/marketplace", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { agents: MarketplaceAgent[] };
      setAgents(j.agents);
    } catch {
      /* ignore */
    }
  }, []);

  // Idempotency guard: if the user already finished onboarding once,
  // skip straight to `next`. Source of truth is
  // user_profile.extra.onboarded_at (set when they click Continue
  // or Skip). This handles: (1) user hits /onboarding manually from
  // the URL bar, (2) router.replace race, (3) /onboarding bookmarked.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/memory", { cache: "no-store" });
        if (!alive) return;
        if (!res.ok) {
          // 401 means middleware will have already redirected — but
          // if we land here with a bad response, just show the page.
          setCheckedOnboarded(true);
          return;
        }
        const j = (await res.json()) as {
          profile?: { extra?: Record<string, unknown> } | null;
        };
        const onboardedAt = j.profile?.extra?.["onboarded_at"];
        if (typeof onboardedAt === "string" && onboardedAt.length > 0) {
          router.replace(next);
          return;
        }
        setCheckedOnboarded(true);
      } catch {
        if (alive) setCheckedOnboarded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [next, router]);

  // Load the catalog. The marketplace route already annotates each
  // agent with the user's connection status, so coming back from an
  // OAuth round-trip re-renders with the correct "Connected" badge.
  useEffect(() => {
    if (!checkedOnboarded) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/marketplace", { cache: "no-store" });
        if (!alive) return;
        if (!res.ok) {
          setError("Couldn't load the app catalog.");
          return;
        }
        const j = (await res.json()) as { agents: MarketplaceAgent[] };
        setAgents(j.agents);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [checkedOnboarded]);

  const connectedCount = useMemo(() => {
    if (!agents) return 0;
    return agents.filter((a) => a.connection?.status === "active").length;
  }, [agents]);

  const startConnect = useCallback(
    async (agent: MarketplaceAgent) => {
      if (connecting) return;

      // MCP bearer servers use the token-paste modal (OAuth DCR
      // for MCP lands in Phase 1c). Public MCP servers have
      // nothing to connect.
      if (agent.source === "mcp") {
        if (agent.connect_model === "mcp_bearer") {
          setMcpModalFor(agent);
        }
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
            // After the OAuth round-trip the provider will bounce
            // the user back here so they can keep connecting more
            // apps. The `connected=` query string triggers a tiny
            // "connected" toast on return.
            redirect_after: `/onboarding?next=${encodeURIComponent(next)}&connected=${agent.agent_id}`,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          throw new Error(
            (j?.detail as string | undefined) ??
              (j?.error as string | undefined) ??
              `HTTP ${res.status}`,
          );
        }
        const { authorize_url } = (await res.json()) as {
          authorize_url: string;
        };
        window.location.href = authorize_url;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setConnecting(null);
      }
    },
    [connecting, next],
  );

  /**
   * Mark the user as onboarded and route them to `next`. Runs on
   * Continue AND Skip — in both cases we don't want /onboarding to
   * come back unless the user resets via a power-user path.
   */
  const finishOnboarding = useCallback(
    async (origin: "continue" | "skip") => {
      if (finishing) return;
      setFinishing(true);
      try {
        // PATCH the flag. We don't block the redirect on the PATCH
        // succeeding — the worst case of a dropped write is that
        // the user sees /onboarding once more on a hard refresh,
        // which is a better failure mode than being stuck here.
        const body = {
          extra: {
            onboarded_at: new Date().toISOString(),
            onboarded_via: origin,
            connectors_at_onboarding: connectedCount,
          },
        };
        void fetch("/api/memory/profile", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        /* ignore */
      }
      router.replace(next);
    },
    [connectedCount, finishing, next, router],
  );

  if (!checkedOnboarded) return <OnboardingShell />;

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex flex-col">
      {/* Header — restrained. No nav, no chat link, no theme toggle
          in the corner, just the wordmark and the Skip escape hatch.
          The goal is to feel like a finishing step, not a subpage. */}
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">
              /
            </span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">
              Set up your apps
            </span>
          </div>
          <div className="flex items-center gap-2">
            {connectedCount > 0 ? (
              <span className="text-[11.5px] text-lumo-fg-mid border border-lumo-hair rounded-full px-2.5 py-1 num">
                {connectedCount} connected
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void finishOnboarding("skip")}
              disabled={finishing}
              className="h-8 px-3 rounded-md text-[12.5px] text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated transition-colors disabled:opacity-50"
              aria-label="Skip onboarding"
            >
              Skip for now
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-5 py-10 flex-1">
        <div className="mb-8 space-y-3 max-w-2xl">
          <h1 className="font-display text-[44px] md:text-[60px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
            Connect the apps <span className="italic text-lumo-accent">Lumo can act on.</span>
          </h1>
          <p className="text-[15px] text-lumo-fg-mid leading-[1.65] max-w-xl">
            Each connection lets Lumo act on your behalf — order food,
            book a flight, grab tickets, post to your channels, and more.
            You can add or remove these anytime from Memory. Nothing is
            shared without a confirmation card you see first.
          </p>
        </div>

        {params.get("connected") ? (
          <div className="mb-5 rounded-md border border-lumo-ok/30 bg-lumo-ok/10 px-3 py-2 text-[12.5px] text-lumo-ok">
            Connected. Pick another, or continue when you&apos;re done.
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            {error}
          </div>
        ) : null}

        {!agents ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-36 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse"
              />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-6 text-center">
            <div className="text-[14px] text-lumo-fg-mid">
              No apps in the catalog yet. You can continue to Lumo —
              we&apos;ll prompt you to connect things the first time
              you ask for them.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((a) => (
              <AgentCard
                key={a.agent_id}
                agent_id={a.agent_id}
                display_name={a.display_name}
                one_liner={a.one_liner}
                category={a.listing?.category ?? null}
                logo_url={a.listing?.logo_url ?? null}
                pricing_note={a.listing?.pricing_note ?? null}
                connected={a.connection?.status === "active"}
                connecting={connecting === a.agent_id}
                source={a.source}
                onConnect={
                  a.connect_model === "oauth2" ||
                  a.connect_model === "mcp_bearer"
                    ? () => void startConnect(a)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer pin — Continue is always available, no matter how
          many (or few) apps are connected. The hint copy nudges
          without nagging. */}
      <footer className="sticky bottom-0 z-10 border-t border-lumo-hair bg-lumo-bg/90 backdrop-blur-md">
        <div className="mx-auto w-full max-w-5xl px-5 py-4 flex items-center justify-between gap-3">
          <div className="text-[12.5px] text-lumo-fg-low">
            {connectedCount === 0
              ? "You can connect apps later from Memory."
              : connectedCount === 1
                ? "1 app connected. Nice."
                : `${connectedCount} apps connected. Nice.`}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/memory"
              className="hidden sm:inline-flex h-9 px-3 rounded-md items-center text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
            >
              Go to memory
            </Link>
            <button
              type="button"
              onClick={() => void finishOnboarding("continue")}
              disabled={finishing}
              className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors disabled:opacity-50"
            >
              {finishing ? "Going to Lumo…" : "Continue to Lumo"}
            </button>
          </div>
        </div>
      </footer>

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
