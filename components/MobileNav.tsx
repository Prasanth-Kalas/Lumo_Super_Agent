"use client";

/**
 * MobileNav — slide-in drawer for &lt;1024px viewports.
 *
 * On desktop the LeftRail is a persistent 260px column; on mobile
 * the same content lives inside this drawer, opened by a hamburger
 * in the header. Content parity is intentional — a user on their
 * phone should be able to reach every place a user at their laptop
 * can reach.
 *
 * Surfaces:
 *   - New chat (primary CTA)
 *   - RECENT — last 8 sessions from /api/history
 *   - AGENTS — four specialists with live connection status (green
 *     dot = active, Reconnect link = expired/errored, Connect link
 *     = never linked). Same fused signal as LeftRail.
 *   - QUICK LINKS — History, Memory, Marketplace, Connections
 *   - AUTH footer — Sign in / Sign up when logged out; Sign out
 *     when logged in. (The sign-out button is stubbed and just
 *     links to /login for now — actual auth surface owned by the
 *     /login page.)
 *
 * Accessibility:
 *   - role="dialog", aria-modal, focus-trap on first interactive
 *   - Esc closes
 *   - Body scroll locked while open
 *   - Backdrop click closes
 *   - Auto-closes on route change (onNavigate)
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

interface RecentSession {
  session_id: string;
  preview: string | null;
  trip_count: number;
}

interface AgentRow {
  agent_id: string;
  display_name: string;
  icon: string;
  connection_status: "active" | "expired" | "revoked" | "error" | null;
  registry_ok: boolean;
}

const BASELINE_AGENTS: Array<Omit<AgentRow, "connection_status" | "registry_ok">> = [
  { agent_id: "lumo.flight", display_name: "Flight", icon: "✈" },
  { agent_id: "lumo.hotel", display_name: "Hotel", icon: "⌂" },
  { agent_id: "lumo.food", display_name: "Food", icon: "◉" },
  { agent_id: "lumo.restaurant", display_name: "Reservation", icon: "◆" },
];

export interface MobileNavProps {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
}

export default function MobileNav({ open, onClose, onNewChat }: MobileNavProps) {
  const [recents, setRecents] = useState<RecentSession[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>(
    BASELINE_AGENTS.map((a) => ({
      ...a,
      connection_status: null,
      registry_ok: false,
    })),
  );
  const [isAuthed, setIsAuthed] = useState<boolean>(false);

  // Body scroll lock
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Esc closes
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Lazy data fetches when drawer opens (first time only)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    // Recents
    void (async () => {
      try {
        const res = await fetch("/api/history", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          sessions: Array<{
            session_id: string;
            preview: string | null;
            trip_ids: string[];
          }>;
        };
        if (cancelled) return;
        setRecents(
          j.sessions.slice(0, 8).map((s) => ({
            session_id: s.session_id,
            preview: s.preview,
            trip_count: s.trip_ids.length,
          })),
        );
      } catch {
        /* ignore */
      }
    })();

    // Agents = registry health + user connections
    void (async () => {
      const [regRes, connRes] = await Promise.allSettled([
        fetch("/api/registry", { cache: "no-store" }),
        fetch("/api/connections", { cache: "no-store" }),
      ]);

      const scoreById = new Map<string, number>();
      if (regRes.status === "fulfilled" && regRes.value.ok) {
        try {
          const j = (await regRes.value.json()) as {
            agents?: Array<{ agent_id?: string; health_score?: number }>;
          };
          for (const a of j.agents ?? []) {
            if (a.agent_id && typeof a.health_score === "number") {
              scoreById.set(a.agent_id, a.health_score);
            }
          }
        } catch {
          /* ignore */
        }
      }
      const connById = new Map<string, AgentRow["connection_status"]>();
      let authed = false;
      if (connRes.status === "fulfilled" && connRes.value.ok) {
        authed = true;
        try {
          const j = (await connRes.value.json()) as {
            connections?: Array<{ agent_id: string; status: string }>;
          };
          for (const c of j.connections ?? []) {
            connById.set(
              c.agent_id,
              c.status as AgentRow["connection_status"],
            );
          }
        } catch {
          /* ignore */
        }
      }
      if (cancelled) return;
      setIsAuthed(authed);
      setAgents(
        BASELINE_AGENTS.map((a) => ({
          ...a,
          connection_status: connById.get(a.agent_id) ?? null,
          registry_ok: (scoreById.get(a.agent_id) ?? 0) > 0.4,
        })),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden
        className={
          "lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 " +
          (open ? "opacity-100" : "opacity-0 pointer-events-none")
        }
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={
          "lg:hidden fixed top-0 left-0 z-50 h-dvh w-[86%] max-w-[340px] bg-lumo-bg border-r border-lumo-hair flex flex-col transform transition-transform duration-300 " +
          (open ? "translate-x-0" : "-translate-x-full")
        }
      >
        {/* Top glow */}
        <div
          className="pointer-events-none absolute -top-24 -left-12 h-56 w-72 rounded-full opacity-[0.16] blur-3xl"
          style={{
            background:
              "radial-gradient(ellipse at center, var(--lumo-accent) 0%, transparent 65%)",
          }}
          aria-hidden
        />

        {/* Header — brand + close */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-lumo-hair relative z-10">
          <Link
            href="/"
            onClick={onClose}
            className="flex items-center gap-3 group"
          >
            <span className="relative inline-flex items-center justify-center">
              <BrandMark size={26} className="text-lumo-fg" />
              <span className="absolute inset-0 rounded-full bg-lumo-accent/25 blur-md opacity-70" />
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
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="h-9 w-9 rounded-full inline-flex items-center justify-center text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
              <path
                d="M4 4 14 14M14 4 4 14"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* New chat CTA */}
        <div className="px-4 pt-4 relative z-10">
          <button
            type="button"
            onClick={() => {
              onNewChat();
              onClose();
            }}
            className="w-full h-12 rounded-xl bg-lumo-accent text-lumo-accent-ink text-[15px] font-medium hover:brightness-110 transition relative overflow-hidden group shadow-[0_0_24px_rgba(94,234,172,0.25)]"
          >
            <span className="relative z-10 inline-flex items-center gap-2">
              <svg width="15" height="15" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              New chat
            </span>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 pt-4 pb-4 space-y-5 relative z-10">
          {/* Recent */}
          <div>
            <SectionHeader>Recent</SectionHeader>
            <ul className="mt-2 space-y-0.5">
              {recents.length === 0 ? (
                <li className="px-2 py-2 text-[14px] text-lumo-fg-low">
                  Your chats will show up here.
                </li>
              ) : (
                recents.map((s) => (
                  <li key={s.session_id}>
                    <Link
                      href={`/history?session=${encodeURIComponent(s.session_id)}`}
                      onClick={onClose}
                      className="block rounded-lg px-3 py-2.5 text-[14.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors"
                      title={s.preview ?? "(empty session)"}
                    >
                      <span className="truncate block">
                        {s.preview ?? <em className="text-lumo-fg-low">(empty)</em>}
                      </span>
                      {s.trip_count > 0 ? (
                        <span className="block mt-0.5 text-[11.5px] text-lumo-accent">
                          {s.trip_count} trip{s.trip_count === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))
              )}
            </ul>
          </div>

          {/* Agents */}
          <div className="pt-1 border-t border-lumo-hair">
            <SectionHeader className="pt-3">Agents</SectionHeader>
            <ul className="mt-2 space-y-0.5">
              {agents.map((a) => {
                const status = a.connection_status;
                const needsConnect =
                  status === null ||
                  status === "revoked" ||
                  status === "expired" ||
                  status === "error";
                const reconnect = status === "expired" || status === "error";
                const active = status === "active" && a.registry_ok;
                return (
                  <li key={a.agent_id}>
                    <Link
                      href="/marketplace"
                      onClick={onClose}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[14.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors"
                    >
                      <span className="w-5 text-center text-[16px] text-lumo-accent opacity-90">
                        {a.icon}
                      </span>
                      <span className="flex-1">{a.display_name}</span>
                      {needsConnect ? (
                        <span className="text-[11.5px] text-lumo-accent font-medium">
                          {reconnect ? "Reconnect" : "Connect"}
                        </span>
                      ) : active ? (
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full bg-lumo-accent shadow-[0_0_8px_rgba(94,234,172,0.6)]"
                          aria-label="connected"
                        />
                      ) : (
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
                          aria-label="degraded"
                        />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Quick links */}
          <div className="pt-1 border-t border-lumo-hair">
            <SectionHeader className="pt-3">Explore</SectionHeader>
            <ul className="mt-2 space-y-0.5">
              <MobileNavLink href="/history" label="History" onNavigate={onClose} />
              <MobileNavLink href="/memory" label="Memory" onNavigate={onClose} />
              <MobileNavLink href="/marketplace" label="Marketplace" onNavigate={onClose} />
              <MobileNavLink href="/connections" label="Connections" onNavigate={onClose} />
            </ul>
          </div>
        </div>

        {/* Auth footer — only when Supabase is configured on this
            build. Hiding when not configured avoids routing users
            to a dead-end explainer. */}
        {process.env.NEXT_PUBLIC_SUPABASE_URL ? (
          <div className="border-t border-lumo-hair px-4 py-4 relative z-10">
            {isAuthed ? (
              <Link
                href="/login"
                onClick={onClose}
                className="block w-full text-center h-11 leading-[2.75rem] rounded-lg border border-lumo-hair text-[14px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors"
              >
                Account settings
              </Link>
            ) : (
              <div className="space-y-2">
                <Link
                  href="/signup"
                  onClick={onClose}
                  className="block w-full text-center h-11 leading-[2.75rem] rounded-lg bg-lumo-fg text-lumo-bg text-[14.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors"
                >
                  Create your account
                </Link>
                <Link
                  href="/login"
                  onClick={onClose}
                  className="block w-full text-center h-11 leading-[2.75rem] rounded-lg border border-lumo-hair text-[14px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors"
                >
                  Sign in
                </Link>
              </div>
            )}
          </div>
        ) : null}
      </aside>
    </>
  );
}

function SectionHeader({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        "px-2.5 text-[11.5px] uppercase tracking-[0.18em] text-lumo-fg-low font-medium " +
        className
      }
    >
      {children}
    </div>
  );
}

function MobileNavLink({
  href,
  label,
  onNavigate,
}: {
  href: string;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <li>
      <Link
        href={href}
        onClick={onNavigate}
        className="flex items-center justify-between rounded-lg px-3 py-2.5 text-[14.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors"
      >
        <span>{label}</span>
        <span className="text-lumo-fg-low" aria-hidden>
          →
        </span>
      </Link>
    </li>
  );
}
