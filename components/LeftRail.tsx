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
  /**
   * "ok" = registry healthy AND user has an active connection.
   * "degraded" = registry healthy but connection is expired/errored.
   * "offline" = registry says unhealthy OR user has no connection.
   */
  health: "ok" | "degraded" | "offline";
  /** Real OAuth status from /api/connections, or null if never connected. */
  connection_status: "active" | "expired" | "revoked" | "error" | null;
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
const BASELINE_AGENTS: Omit<AgentHealth, "health" | "connection_status">[] = [
  { agent_id: "lumo.flight", display_name: "Flight", icon: "✈" },
  { agent_id: "lumo.hotel", display_name: "Hotel", icon: "⌂" },
  { agent_id: "lumo.food", display_name: "Food", icon: "◉" },
  { agent_id: "lumo.restaurant", display_name: "Reservation", icon: "◆" },
];

export default function LeftRail({ onNewChat, currentSessionId }: LeftRailProps) {
  const [recents, setRecents] = useState<RecentSession[]>([]);
  const [agents, setAgents] = useState<AgentHealth[]>(
    BASELINE_AGENTS.map((a) => ({
      ...a,
      health: "offline" as const,
      connection_status: null,
    })),
  );
  // Auth state — driven by /api/connections responding 200 vs 401.
  // 200 = signed in (user has a Lumo account). 401 = logged out.
  // null = still loading / server unreachable. We show auth CTAs
  // when the value is false, and an account link when it's true.
  const [isAuthed, setIsAuthed] = useState<boolean | null>(null);

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

  // Registry + connection health — both lazy, fused into one effect
  // so we compute final health with both signals. Registry tells us
  // "is the agent up"; connections tells us "is the user linked".
  // A green dot means BOTH. An amber dot means the agent is up but
  // the user's token is expired/errored. Gray means not connected
  // at all (with a Connect CTA), or the agent itself is offline.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [regRes, connRes] = await Promise.allSettled([
        fetch("/api/registry", { cache: "no-store" }),
        fetch("/api/connections", { cache: "no-store" }),
      ]);

      const scoreById = new Map<string, number>();
      if (regRes.status === "fulfilled" && regRes.value.ok) {
        try {
          const j = (await regRes.value.json()) as {
            agents?: Array<{
              agent_id?: string;
              health_score?: number;
            }>;
          };
          for (const a of j.agents ?? []) {
            if (a.agent_id && typeof a.health_score === "number") {
              scoreById.set(a.agent_id, a.health_score);
            }
          }
        } catch {
          /* ignore parse error — leave registry empty */
        }
      }

      const connById = new Map<string, AgentHealth["connection_status"]>();
      if (connRes.status === "fulfilled" && connRes.value.ok) {
        try {
          const j = (await connRes.value.json()) as {
            connections?: Array<{ agent_id: string; status: string }>;
          };
          for (const c of j.connections ?? []) {
            connById.set(
              c.agent_id,
              c.status as AgentHealth["connection_status"],
            );
          }
        } catch {
          /* ignore */
        }
      }
      // /api/connections 401s when auth isn't configured — treat as
      // "we can't know", don't overlay connection state. Registry
      // health alone drives the dot in that mode.
      const haveConnections = connRes.status === "fulfilled" && connRes.value.ok;

      // Auth inference: 200 → signed in. 401 → logged out. Other
      // errors or network failure → leave null so we don't flash
      // the wrong CTA.
      if (!cancelled) {
        if (connRes.status === "fulfilled") {
          if (connRes.value.ok) setIsAuthed(true);
          else if (connRes.value.status === 401) setIsAuthed(false);
        }
      }

      if (cancelled) return;
      setAgents(
        BASELINE_AGENTS.map((a) => {
          const score = scoreById.get(a.agent_id) ?? 0;
          const registryUp = score > 0.4;
          const conn = connById.get(a.agent_id) ?? null;

          let health: AgentHealth["health"];
          if (!haveConnections) {
            // No auth / no connections endpoint — fall back to
            // registry-only, same as the pre-J5 behavior.
            health = score > 0.8 ? "ok" : score > 0.4 ? "degraded" : "offline";
          } else if (conn === "active" && registryUp) {
            health = "ok";
          } else if (conn === "active" && !registryUp) {
            health = "degraded"; // agent itself is down
          } else if (conn === "expired" || conn === "error") {
            health = "degraded"; // reconnect required
          } else {
            health = "offline"; // not connected
          }

          return { ...a, health, connection_status: conn };
        }),
      );
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
            {agents.map((a) => {
              const needsConnect =
                a.connection_status === null ||
                a.connection_status === "revoked" ||
                a.connection_status === "expired" ||
                a.connection_status === "error";
              const needsReconnect =
                a.connection_status === "expired" ||
                a.connection_status === "error";
              return (
                <li
                  key={a.agent_id}
                  className="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13.5px] text-lumo-fg-mid hover:bg-lumo-elevated/60 hover:text-lumo-fg transition-colors group"
                  title={tooltipForAgent(a)}
                >
                  <span className="w-5 text-center text-[15px] text-lumo-accent opacity-90">
                    {a.icon}
                  </span>
                  <span className="flex-1 truncate">{a.display_name}</span>
                  {needsConnect ? (
                    <Link
                      href="/marketplace"
                      className="text-[11px] text-lumo-fg-low group-hover:text-lumo-accent underline-offset-4 hover:underline"
                    >
                      {needsReconnect ? "Reconnect" : "Connect"}
                    </Link>
                  ) : (
                    <HealthDot health={a.health} />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Footer — auth + nav */}
      <div className="border-t border-lumo-hair relative z-10">
        {/* Auth block only renders when the Supabase public env is
            baked into this build AND we have a definite auth signal
            from /api/connections. Otherwise we skip the block so
            users don't see "Sign in" CTAs that lead to a dead-end
            explainer. */}
        {process.env.NEXT_PUBLIC_SUPABASE_URL && isAuthed === false ? (
          <div className="px-4 pt-3 pb-2 space-y-2">
            <Link
              href="/signup"
              className="block w-full text-center h-10 leading-[2.5rem] rounded-lg bg-lumo-fg text-lumo-bg text-[13.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors"
            >
              Create account
            </Link>
            <Link
              href="/login"
              className="block w-full text-center h-9 leading-[2.25rem] rounded-lg border border-lumo-hair text-[13px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors"
            >
              Sign in
            </Link>
          </div>
        ) : process.env.NEXT_PUBLIC_SUPABASE_URL && isAuthed === true ? (
          <div className="px-4 pt-3 pb-1">
            <Link
              href="/memory"
              className="block w-full rounded-lg border border-lumo-hair px-3 py-2 text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors inline-flex items-center gap-2"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-lumo-accent shadow-[0_0_6px_rgba(94,234,172,0.6)]" />
              Signed in
            </Link>
          </div>
        ) : null}

        <div className="px-4 pt-2 pb-3 space-y-0.5">
          <FooterLink href="/history" label="History" />
          <FooterLink href="/marketplace" label="Marketplace" />
          <FooterLink href="/connections" label="Connections" />
        </div>
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

function tooltipForAgent(a: AgentHealth): string {
  const parts: string[] = [a.display_name];
  switch (a.connection_status) {
    case "active":
      parts.push("connected");
      break;
    case "expired":
      parts.push("token expired — reconnect");
      break;
    case "revoked":
      parts.push("revoked — reconnect to use again");
      break;
    case "error":
      parts.push("connection error");
      break;
    case null:
      parts.push("not connected");
      break;
  }
  if (a.health === "degraded") parts.push("agent degraded");
  return parts.join(" · ");
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
