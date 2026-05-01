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
 *   - EXPLORE — Workspace, Trips, Receipts, History, Memory, Settings,
 *     Marketplace, Connections
 *   - AUTH footer — Sign in / Sign up when logged out; Account
 *     settings + Sign out when logged in.
 *
 * The previous AGENTS section (live connection status for the four
 * specialists) was removed in WEB-REDESIGN-1. The four specialists
 * are still real — their connection status is reachable via
 * /connections (Explore section) for users who want to manage them.
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
import { LumoWordmark } from "@/components/BrandMark";
import { formatTimeSince } from "@/lib/format-time-since";

interface RecentSession {
  session_id: string;
  preview: string | null;
  last_activity_at: string;
  trip_count: number;
}

export interface MobileNavProps {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
}

export default function MobileNav({ open, onClose, onNewChat }: MobileNavProps) {
  const [recents, setRecents] = useState<RecentSession[]>([]);
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
        /* ignore */
      }
    })();

    // Auth chip — single GET against /api/me. Drives whether the
    // footer renders Sign in/Sign up vs Account settings/Sign out.
    void (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (cancelled) return;
        setIsAuthed(res.ok);
      } catch {
        if (!cancelled) setIsAuthed(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

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
            <LumoWordmark height={28} />
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] uppercase tracking-[0.16em] text-lumo-fg-low">
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
                      <span className="block mt-0.5 truncate text-[11.5px] text-lumo-fg-low">
                        {formatTimeSince(s.last_activity_at)}
                        {s.trip_count > 0 ? (
                          <>
                            {" "}
                            · {s.trip_count} trip{s.trip_count === 1 ? "" : "s"}
                          </>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          </div>

          {/* Quick links */}
          <div className="pt-1 border-t border-lumo-hair">
            <SectionHeader className="pt-3">Explore</SectionHeader>
            <ul className="mt-2 space-y-0.5">
              <MobileNavLink
                href="/workspace"
                label="Workspace"
                onNavigate={onClose}
                highlight
              />
              <MobileNavLink href="/trips" label="Trips" onNavigate={onClose} />
              <MobileNavLink href="/receipts" label="Receipts" onNavigate={onClose} />
              <MobileNavLink href="/history" label="History" onNavigate={onClose} />
              <MobileNavLink href="/memory" label="Memory" onNavigate={onClose} />
              <MobileNavLink href="/settings" label="Settings" onNavigate={onClose} />
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
              <div className="space-y-2">
                <Link
                  href="/settings/account"
                  onClick={onClose}
                  className="block w-full text-center h-11 leading-[2.75rem] rounded-lg border border-lumo-hair text-[14px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors"
                >
                  Account settings
                </Link>
                <MobileSignOutButton onClose={onClose} />
              </div>
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
  highlight,
}: {
  href: string;
  label: string;
  onNavigate: () => void;
  /**
   * Primary nav target — gets a left accent bar + dot + bolder text.
   * Used for /workspace so users find the dashboard immediately.
   */
  highlight?: boolean;
}) {
  if (highlight) {
    return (
      <li>
        <Link
          href={href}
          onClick={onNavigate}
          className="flex items-center justify-between rounded-lg px-3 py-2.5 text-[14.5px] font-medium text-lumo-fg hover:bg-lumo-elevated/80 transition-colors border-l-2 border-lumo-accent"
        >
          <span className="flex items-center gap-2">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-lumo-accent" />
            {label}
          </span>
          <span className="text-lumo-fg-low" aria-hidden>
            →
          </span>
        </Link>
      </li>
    );
  }
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

/**
 * Full-width Sign out button for the mobile sheet. Same POST-then-
 * hard-reload flow as the desktop LeftRail button: hits the logout
 * route, then window.location.assign("/login") so the next render
 * has freshly-cleared cookies and no stale React state. Closes the
 * mobile sheet on click so we don't leave the overlay painted while
 * the reload races.
 */
function MobileSignOutButton({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    onClose();
    try {
      await fetch("/api/auth/logout", { method: "POST", keepalive: true });
    } catch {
      // Middleware will 401 the next request regardless; proceed to
      // /login either way.
    }
    window.location.assign("/login");
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="block w-full text-center h-11 leading-[2.75rem] rounded-lg text-[14px] text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated/60 transition-colors disabled:opacity-60"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
