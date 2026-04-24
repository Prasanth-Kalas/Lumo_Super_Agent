"use client";

/**
 * LeftRail — persistent navigation column for the JARVIS dashboard.
 *
 * What the user sees at a glance:
 *   - Brand mark + "one app, any task" tag
 *   - New chat button (primary action — always reachable)
 *   - RECENT CONVERSATIONS — last N sessions, click to resume (fetches
 *     /api/history lazily on mount; empty state when persistence is off)
 *   - AGENTS — a live health panel listing every connected specialist
 *     (flight, hotel, food, restaurant) with a pulsing dot. Green =
 *     healthy, amber = degraded, gray = not configured.
 *   - Footer nav: History, Marketplace, Connections, Settings
 *
 * Purpose: turn "Lumo is a chat box" into "Lumo is a multi-agent
 * operator console" by making the agent ecosystem visible at all
 * times. The rail also gives the user one-click access to past
 * trips without leaving the chat.
 *
 * Self-contained — doesn't know about the chat thread, summaries, or
 * voice. The shell wires it alongside the center column via CSS grid.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

interface RecentSession {
  session_id: string;
  preview: string | null;
  last_activity_at: string;
  trip_count: number;
}

interface AgentHealth {
  agent_id: string;
  display_name: string;
  icon: string;
  health: "ok" | "degraded" | "offline";
}

export interface LeftRailProps {
  /** Emitted when the user hits "New chat". Shell resets thread state. */
  onNewChat: () => void;
  /** Active session id so the current session gets highlighted in recents. */
  currentSessionId?: string | null;
}

// Static baseline — we render these even if /api/registry is empty
// so the user always knows what Lumo can do. Health gets overlaid
// from the registry when available.
const BASELINE_AGENTS: Omit<AgentHealth, "health">[] = [
  { agent_id: "lumo.flight", display_name: "Flight", icon: "✈" },
  { agent_id: "lumo.hotel", display_name: "Hotel", icon: "⌂" },
  { agent_id: "lumo.food", display_name: "Food", icon: "◉" },
  { agent_id: "lumo.restaurant", display_name: "Reservation", icon: "◆" },
];

export default function LeftRail({ onNewChat, currentSessionId }: LeftRailProps) {
  const [recents, setRecents] = useState<RecentSession[]>([]);
  const [agents, setAgents] = useState<AgentHealth[]>(
    BASELINE_AGENTS.map((a) => ({ ...a, health: "offline" as const })),
  );

  // Lazy-load recents. We don't block the first paint waiting for
  // them — the rail renders immediately with an empty state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/history", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          sessions: Array<{
            session_id: string;
            preview: string | null;
            last_activity_at: string;
            trip_ids: string[];
          }>;
        };
        if (cancelled) return;
        setRecents(
          j.sessions.slice(0, 8).map((s) => ({
            session_id: s.session_id,
            preview: s.preview,
            last_activity_at: s.last_activity_at,
            trip_count: s.trip_ids.length,
          })),
        );
      } catch {
        // persistence disabled, no recents — fine.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Registry health — also lazy. The registry endpoint returns the
  // agent manifests + last-seen times; we map to ok/degraded/offline.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/registry", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          agents?: Array<{
            agent_id?: string;
            display_name?: string;
            health_score?: number;
          }>;
        };
        if (cancelled) return;
        const byId = new Map<string, number>();
        for (const a of j.agents ?? []) {
          if (a.agent_id && typeof a.health_score === "number") {
            byId.set(a.agent_id, a.health_score);
          }
        }
        setAgents(
          BASELINE_AGENTS.map((a) => {
            const score = byId.get(a.agent_id) ?? 0;
            const health: AgentHealth["health"] =
              score > 0.8 ? "ok" : score > 0.4 ? "degraded" : "offline";
            return { ...a, health };
          }),
        );
      } catch {
        // registry endpoint not available — rail stays offline.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="hidden lg:flex h-full w-[260px] shrink-0 flex-col border-r border-lumo-hair bg-lumo-bg relative overflow-hidden">
      {/* Ambient top glow — same warmth as the right rail */}
      <div
        className="pointer-events-none absolute -top-24 -left-12 h-56 w-72 rounded-full opacity-[0.16] blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--lumo-accent) 0%, transparent 65%)",
        }}
        aria-hidden
      />

      {/* Brand header */}
      <div className="px-5 pt-5 pb-4 border-b border-lumo-hair relative z-10">
        <Link href="/" className="flex items-center gap-3 group">
          <span className="relative inline-flex items-center justify-center">
            <BrandMark size={26} className="text-lumo-fg" />
            <span className="absolute inset-0 rounded-full bg-lumo-accent/25 blur-md opacity-70 group-hover:opacity-100 transition-opacity" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-[16px] font-semibold tracking-tight text-lumo-fg">
              Lumo
            </span>
            <span className="text-[11px] uppercase tracking-[0.16em] text-lumo-fg-low mt-0.5">
              one app · any task
            </span>
          </div>
        </Link>
      </div>

      {/* New chat */}
      <div className="px-4 pt-4 pb-2 relative z-10">
        <button
          type="button"
          onClick={onNewChat}
          className="w-full h-11 rounded-xl bg-lumo-accent text-lumo-accent-ink text-[14px] font-medium hover:brightness-110 transition relative overflow-hidden group shadow-[0_0_24px_rgba(94,234,172,0.25)]"
        >
          <span className="relative z-10 inline-flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            New chat
          </span>
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.3),transparent_60%)] opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto relative z-10">
        {/* Recents */}
        <div className="px-4 pt-3 pb-3">
          <SectionHeader>Recent</SectionHeader>
          <ul className="mt-2 space-y-0.5">
            {recents.length === 0 ? (
              <li className="px-2 py-2 text-[13px] text-lumo-fg-low leading-relaxed">
                Your chats will show up here.
              </li>
            ) : (
              recents.map((s) => {
                const isActive = s.session_id === currentSessionId;
                return (
                  <li key={s.session_id}>
                    <Link
                      href={`/history?session=${encodeURIComponent(s.session_id)}`}
                      className={
                        "block rounded-lg px-2.5 py-2 text-[13.5px] truncate transition-colors " +
                        (isActive
                          ? "bg-lumo-elevated text-lumo-fg"
                          : "text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60")
                      }
                      title={s.preview ?? "(empty session)"}
                    >
                      <span className="truncate">
                        {s.preview ?? <em className="text-lumo-fg-low">(empty)</em>}
                      </span>
                      {s.trip_count > 0 ? (
                        <span className="ml-1.5 inline-block text-[11px] text-lumo-accent align-middle">
                          · {s.trip_count} trip{s.trip_count === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })
            )}
          </ul>
        </div>

        {/* Agents */}
        <div className="px-4 pt-2 pb-3 mt-1 border-t border-lumo-hair">
          <SectionHeader>Agents</SectionHeader>
          <ul className="mt-2 space-y-0.5">
            {agents.map((a) => (
              <li
                key={a.agent_id}
                className="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13.5px] text-lumo-fg-mid hover:bg-lumo-elevated/60 hover:text-lumo-fg transition-colors"
                title={`${a.display_name} — ${a.health}`}
              >
                <span className="w-5 text-center text-[15px] text-lumo-accent opacity-90">
                  {a.icon}
                </span>
                <span className="flex-1 truncate">{a.display_name}</span>
                <HealthDot health={a.health} />
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Footer nav */}
      <div className="border-t border-lumo-hair px-4 py-3 space-y-0.5 relative z-10">
        <FooterLink href="/history" label="History" />
        <FooterLink href="/marketplace" label="Marketplace" />
        <FooterLink href="/connections" label="Connections" />
      </div>
    </aside>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 text-[11px] uppercase tracking-[0.18em] text-lumo-fg-low font-medium">
      {children}
    </div>
  );
}

function FooterLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block rounded-lg px-2.5 py-2 text-[13px] text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors"
    >
      {label}
    </Link>
  );
}

function HealthDot({ health }: { health: AgentHealth["health"] }) {
  const cls =
    health === "ok"
      ? "bg-lumo-accent shadow-[0_0_8px_rgba(94,234,172,0.6)]"
      : health === "degraded"
      ? "bg-lumo-warn"
      : "bg-lumo-fg-low/40";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`}
      aria-label={health}
    />
  );
}
