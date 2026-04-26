"use client";

/**
 * RightRail — Marketplace shortcut.
 *
 * Replaces the prior voice/trip/memory panels with a compact view
 * of what apps are available and which the user has connected.
 * Click an app to open its detail page; click "Browse all" to jump
 * to /marketplace.
 *
 * Hidden below xl (1280px) so the chat takes the full width on
 * laptops. Voice mode now lives entirely in the composer (mic
 * button + inline VoiceMode panel) — the right column is for
 * discovery.
 *
 * Exported types (ActiveTripView, LegStatusLite, VoiceStateLite)
 * are kept for callers (chat shell, trip cards) — they don't render
 * here anymore but the shell still constructs them for inline cards.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { VoiceState } from "@/components/VoiceMode";

// ─── Types preserved for callers ─────────────────────────────

export interface LegStatusLite {
  order: number;
  agent_id: string;
  status: "pending" | "in_flight" | "committed" | "failed" | "rolled_back";
}

export interface ActiveTripView {
  trip_title?: string;
  total_amount?: string;
  currency?: string;
  legs: LegStatusLite[];
}

export type VoiceStateLite = VoiceState;

export interface RightRailProps {
  activeTrip: ActiveTripView | null;
  voiceState: VoiceStateLite;
  voiceEnabled: boolean;
  voiceMuted: boolean;
  onToggleVoice: () => void;
  onToggleMuted: () => void;
  userRegion: string;
  onSuggestion: (text: string) => void;
  memoryRefreshKey?: number | string;
}

// ─── Marketplace data shape ──────────────────────────────────

interface MarketplaceAgent {
  agent_id: string;
  display_name: string;
  one_liner: string;
  source?: "lumo" | "mcp";
  listing: {
    category?: string;
    logo_url?: string;
  } | null;
  connection: {
    status: "active" | "expired" | "revoked" | "error";
  } | null;
}

export default function RightRail(_props: RightRailProps) {
  const [agents, setAgents] = useState<MarketplaceAgent[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/marketplace", { cache: "no-store" });
        if (!alive) return;
        if (!res.ok) {
          setAgents([]);
          return;
        }
        const j = (await res.json()) as { agents?: MarketplaceAgent[] };
        setAgents(j.agents ?? []);
      } catch {
        if (alive) setAgents([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const connected = (agents ?? []).filter(
    (a) => a.connection?.status === "active",
  );
  const featured = (agents ?? [])
    .filter((a) => a.connection?.status !== "active")
    .slice(0, 6);

  return (
    <aside className="hidden xl:flex h-full w-[280px] shrink-0 flex-col border-l border-lumo-hair bg-lumo-surface">
      <div className="px-4 py-3 border-b border-lumo-hair flex items-center justify-between">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
            Marketplace
          </div>
          <div className="text-[13.5px] text-lumo-fg mt-0.5">Apps for Lumo</div>
        </div>
        <Link
          href="/marketplace"
          className="text-[11.5px] text-lumo-accent hover:underline underline-offset-4"
        >
          Browse all →
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto">
        {agents === null ? (
          <div className="p-4 text-[12px] text-lumo-fg-low">Loading…</div>
        ) : (
          <>
            {connected.length > 0 ? (
              <div className="px-3 py-3 border-b border-lumo-hair">
                <SectionHeader>Your apps</SectionHeader>
                <ul className="space-y-1 mt-2">
                  {connected.map((a) => (
                    <AgentRow key={a.agent_id} agent={a} connected />
                  ))}
                </ul>
              </div>
            ) : null}

            {featured.length > 0 ? (
              <div className="px-3 py-3">
                <SectionHeader>Discover</SectionHeader>
                <ul className="space-y-1 mt-2">
                  {featured.map((a) => (
                    <AgentRow key={a.agent_id} agent={a} />
                  ))}
                </ul>
              </div>
            ) : (
              <div className="p-4 text-[12px] text-lumo-fg-low">
                Nothing in the catalog yet.
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-lumo-hair px-4 py-3 text-[11.5px] text-lumo-fg-low leading-relaxed">
        New apps you connect will show up here.{" "}
        <Link
          href="/marketplace"
          className="text-lumo-accent hover:underline underline-offset-4"
        >
          Browse all
        </Link>
        .
      </div>
    </aside>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 text-[10px] uppercase tracking-[0.14em] text-lumo-fg-low">
      {children}
    </div>
  );
}

function AgentRow({
  agent,
  connected,
}: {
  agent: MarketplaceAgent;
  connected?: boolean;
}) {
  const slug = agent.agent_id.startsWith("mcp:")
    ? null // MCP cards open the modal; deep link goes to /marketplace
    : agent.agent_id;
  const href = slug ? `/marketplace/${slug}` : "/marketplace";
  return (
    <li>
      <Link
        href={href}
        className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-lumo-elevated transition-colors group"
      >
        <AgentLogo
          name={agent.display_name}
          logoUrl={agent.listing?.logo_url ?? null}
          source={agent.source}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[12.5px] text-lumo-fg truncate">
              {agent.display_name}
            </span>
            {connected ? (
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-g-green shrink-0"
                aria-label="Connected"
              />
            ) : null}
            {agent.source === "mcp" ? (
              <span className="text-[9.5px] uppercase tracking-[0.12em] text-lumo-fg-low border border-lumo-hair rounded px-1 py-px">
                MCP
              </span>
            ) : null}
          </div>
          <div className="text-[11.5px] text-lumo-fg-low line-clamp-2 leading-snug">
            {agent.one_liner}
          </div>
        </div>
      </Link>
    </li>
  );
}

/**
 * Square 32px tile for an agent. Renders the partner-supplied
 * logo_url when present, otherwise a deterministic colored
 * initial tile so each agent feels distinct without us shipping
 * a default grey square. The fallback color is hashed off the
 * display name so the same agent always gets the same color.
 */
function AgentLogo({
  name,
  logoUrl,
  source,
}: {
  name: string;
  logoUrl: string | null;
  source?: MarketplaceAgent["source"];
}) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={logoUrl}
        alt=""
        className="h-8 w-8 rounded-md border border-lumo-hair bg-lumo-bg object-cover shrink-0"
        loading="lazy"
        onError={(e) => {
          // If the URL 404s or CORS errors, drop the img so the
          // initial-tile fallback renders. We do this by clearing
          // src and applying a class on the parent — simpler:
          // just hide the broken image. The initial sits underneath.
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  // Tailwind's JIT can't see dynamic class names — hardcoding the
  // four-color rotation explicitly so each class is statically
  // present in the bundle.
  const tones = [
    "bg-g-blue",
    "bg-g-red",
    "bg-g-yellow",
    "bg-g-green",
  ] as const;
  const tone = tones[hash(name) % tones.length] ?? "bg-g-blue";
  return (
    <div
      className={`h-8 w-8 rounded-md border border-lumo-hair flex items-center justify-center text-[14px] font-semibold text-white shrink-0 ${tone}`}
      aria-hidden
      data-source={source ?? ""}
    >
      {initial}
    </div>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
