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
  const dotColor = connected
    ? "bg-g-green"
    : agent.source === "mcp"
      ? "bg-g-yellow"
      : "bg-g-blue";
  return (
    <li>
      <Link
        href={href}
        className="block rounded-md px-2 py-2 hover:bg-lumo-elevated transition-colors group"
      >
        <div className="flex items-start gap-2.5">
          <span
            className={`mt-1.5 inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[12.5px] text-lumo-fg truncate">
                {agent.display_name}
              </span>
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
        </div>
      </Link>
    </li>
  );
}
