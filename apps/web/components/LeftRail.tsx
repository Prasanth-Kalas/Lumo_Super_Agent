"use client";

/**
 * LeftRail — Claude-Desktop-style sidebar.
 *
 * Just three things, stacked:
 *
 *   1. "+ New chat" button at the top.
 *   2. Search input + flat list of recent conversations.
 *   3. Profile chip at the bottom (avatar + email) that opens a small
 *      menu: Account, History, Marketplace, Admin (if admin), Sign out.
 *
 * Removed from the previous LeftRail:
 *   - Brand mark + tagline (the header already has it).
 *   - Agents health panel (moved to /admin/apps).
 *   - Footer nav links (folded into the profile menu).
 *   - Auth CTAs (the header's auth chip handles signed-out state).
 *
 * The goal is to put conversations front and center, like Claude
 * Desktop, ChatGPT, and every other chat app users now have muscle
 * memory for. Everything else lives behind the profile menu or under
 * /admin / /marketplace.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

interface RecentSession {
  session_id: string;
  preview: string | null;
  last_activity_at: string;
  trip_count: number;
}

interface Me {
  email: string | null;
  full_name: string | null;
  first_name: string | null;
}

export interface LeftRailProps {
  /** Emitted when the user hits "New chat". Shell resets thread state. */
  onNewChat: () => void;
  /** Active session id so the current row gets highlighted. */
  currentSessionId?: string | null;
  /** Bumped after each turn so we can refetch recents lazily. */
  recentsRefreshKey?: number | string;
}

export default function LeftRail({
  onNewChat,
  currentSessionId,
  recentsRefreshKey,
}: LeftRailProps) {
  const [recents, setRecents] = useState<RecentSession[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Recents — pulled lazily so a signed-out user gets an empty
  // sidebar without a 401 spinner.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/history?limit_sessions=30", {
          cache: "no-store",
        });
        if (!alive) return;
        if (!res.ok) {
          setRecents([]);
          return;
        }
        const j = (await res.json()) as { sessions?: RecentSession[] };
        const sessions = (j.sessions ?? []).map((s) => ({
          ...s,
          trip_count: (s as { trip_ids?: string[] }).trip_ids?.length ?? 0,
        }));
        setRecents(sessions);
      } catch {
        if (alive) setRecents([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [recentsRefreshKey]);

  // Identity — fetched once. Drives the profile chip and admin link.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (!alive) return;
        if (!res.ok) {
          setAuthed(false);
          return;
        }
        const j = (await res.json()) as { user?: Me };
        if (j.user) {
          setMe(j.user);
          setAuthed(true);
        } else {
          setAuthed(false);
        }
      } catch {
        if (alive) setAuthed(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Click-outside closes the profile menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const filtered = useMemo(() => {
    if (!recents) return [];
    const q = query.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter((s) => (s.preview ?? "").toLowerCase().includes(q));
  }, [recents, query]);

  const grouped = useMemo(() => groupByDay(filtered), [filtered]);

  return (
    <aside className="hidden lg:flex h-full w-[260px] shrink-0 flex-col border-r border-lumo-hair bg-lumo-surface">
      {/* Top: New chat */}
      <div className="p-3">
        <button
          type="button"
          onClick={onNewChat}
          className="w-full inline-flex items-center justify-between gap-2 rounded-lg border border-lumo-hair bg-lumo-bg px-3 py-2.5 text-[13px] text-lumo-fg hover:border-lumo-edge hover:bg-lumo-elevated transition-colors group"
        >
          <span className="inline-flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path
                d="M7 3v8M3 7h8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            New chat
          </span>
          <kbd className="text-[10px] text-lumo-fg-low border border-lumo-hair rounded px-1 py-0.5 font-mono">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <svg
            width="13"
            height="13"
            viewBox="0 0 13 13"
            fill="none"
            aria-hidden
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-lumo-fg-low"
          >
            <circle
              cx="5.5"
              cy="5.5"
              r="3.5"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="m11 11-2.5-2.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full h-8 rounded-md border border-lumo-hair bg-lumo-bg pl-8 pr-2 text-[12.5px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
          />
        </div>
      </div>

      {/* Recents */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {recents === null ? (
          <div className="px-2 py-4 text-[12px] text-lumo-fg-low">Loading…</div>
        ) : authed === false ? (
          <div className="px-3 py-6 space-y-2">
            <div className="text-[12.5px] text-lumo-fg-mid leading-relaxed">
              Sign in to see your conversations across devices.
            </div>
            <Link
              href="/login"
              className="inline-flex items-center text-[12.5px] text-g-blue hover:underline underline-offset-4"
            >
              Sign in →
            </Link>
          </div>
        ) : grouped.length === 0 ? (
          <div className="px-3 py-6 text-[12px] text-lumo-fg-low">
            {query ? "No matches." : "No conversations yet."}
          </div>
        ) : (
          grouped.map((g) => (
            <div key={g.label} className="mb-3">
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-lumo-fg-low">
                {g.label}
              </div>
              <ul>
                {g.items.map((s) => {
                  const active = s.session_id === currentSessionId;
                  return (
                    <li key={s.session_id}>
                      <a
                        href={`/?session=${encodeURIComponent(s.session_id)}`}
                        className={
                          "block rounded-md px-2.5 py-2 text-[12.5px] leading-snug transition-colors " +
                          (active
                            ? "bg-lumo-elevated text-lumo-fg"
                            : "text-lumo-fg-mid hover:bg-lumo-elevated/60 hover:text-lumo-fg")
                        }
                        aria-current={active ? "page" : undefined}
                      >
                        <div className="line-clamp-2">
                          {s.preview ?? <em className="text-lumo-fg-low">(empty)</em>}
                        </div>
                        {s.trip_count > 0 ? (
                          <div className="mt-0.5 inline-flex items-center text-[10px] text-g-blue">
                            {s.trip_count} trip{s.trip_count === 1 ? "" : "s"}
                          </div>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* Profile chip + menu */}
      <div ref={menuRef} className="relative border-t border-lumo-hair p-2">
        {menuOpen ? (
          <div className="absolute bottom-full left-2 right-2 mb-2 rounded-lg border border-lumo-hair bg-lumo-elevated shadow-xl py-1 z-30">
            <MenuLink href="/settings/account" label="Account" hint="Email, name, sign out" />
            <MenuLink href="/profile" label="Profile" hint="Travel, food, stay preferences" />
            <MenuLink href="/trips" label="Trips" hint="Bookings and itineraries" />
            <MenuLink href="/receipts" label="Receipts" hint="Payments and refunds" />
            <MenuLink href="/history" label="History" hint="Past chats" />
            <MenuLink href="/settings" label="Settings" hint="Notifications, voice, cost" />
            <MenuLink href="/marketplace" label="Marketplace" hint="Connect more apps" />
            <MenuLink href="/admin" label="Admin" hint="Operator console" />
            <div className="my-1 border-t border-lumo-hair" />
            <button
              type="button"
              onClick={async () => {
                try {
                  await fetch("/api/auth/logout", { method: "POST" });
                } catch {
                  /* ignore */
                }
                window.location.href = "/login";
              }}
              className="w-full text-left px-3 py-2 text-[12.5px] text-lumo-fg-mid hover:bg-lumo-bg hover:text-lumo-fg"
            >
              Sign out
            </button>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="w-full inline-flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-lumo-elevated transition-colors"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <div className="h-8 w-8 rounded-full bg-gradient-to-br from-g-blue/30 to-g-green/30 border border-lumo-hair flex items-center justify-center text-[13px] font-semibold text-lumo-fg shrink-0">
            {initialFor(me)}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[12.5px] text-lumo-fg truncate">
              {me?.full_name ?? me?.email ?? "Guest"}
            </div>
            <div className="text-[11px] text-lumo-fg-low truncate">
              {authed ? me?.email ?? "Signed in" : "Not signed in"}
            </div>
          </div>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden
            className="text-lumo-fg-low shrink-0"
          >
            <path
              d="M3 7.5 6 4.5l3 3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function MenuLink({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="block px-3 py-2 hover:bg-lumo-bg transition-colors"
    >
      <div className="text-[12.5px] text-lumo-fg">{label}</div>
      <div className="text-[10.5px] text-lumo-fg-low">{hint}</div>
    </Link>
  );
}

function initialFor(me: Me | null): string {
  const src =
    (me?.first_name && me.first_name.trim()) ||
    (me?.full_name && me.full_name.trim()) ||
    (me?.email && me.email.split("@")[0]) ||
    "";
  const ch = src.charAt(0);
  return ch ? ch.toUpperCase() : "·";
}

interface DayGroup {
  label: string;
  items: RecentSession[];
}

/**
 * Bucket recents by Today / Yesterday / This week / older. Same
 * mental model as Claude Desktop's "Recents" rollup so users feel
 * at home immediately.
 */
function groupByDay(items: RecentSession[]): DayGroup[] {
  if (items.length === 0) return [];
  const now = new Date();
  const today = startOfDay(now);
  const yday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  const groups: DayGroup[] = [];
  const byLabel = new Map<string, DayGroup>();

  for (const s of items) {
    const d = new Date(s.last_activity_at);
    let label: string;
    if (sameDay(d, today)) label = "Today";
    else if (sameDay(d, yday)) label = "Yesterday";
    else if (d >= weekStart) label = "This week";
    else
      label = d.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    const existing = byLabel.get(label);
    if (existing) existing.items.push(s);
    else {
      const g = { label, items: [s] };
      byLabel.set(label, g);
      groups.push(g);
    }
  }
  return groups;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
