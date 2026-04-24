"use client";

/**
 * NotificationBell — the header-bell pattern with an unread count badge
 * and a click-to-open dropdown. Polls /api/notifications every 60s
 * (only when the tab is visible — no point spending battery on a
 * backgrounded tab).
 *
 * Intentionally lightweight: no web push yet, no toast animations, no
 * deep-link routing. Those come when J2 reaches its "delight" milestone.
 * The MVP proves the loop: cron writes → DB → bell polls → user reads.
 *
 * Mounted in the header. Hides itself when the user is logged out (the
 * list endpoint will 401 and we just render the bell muted).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

const POLL_MS = 60_000;

export function NotificationBell({ className }: { className?: string }) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState<number>(0);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pollingRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) {
        // 401 = logged out — silent; 5xx we'll retry on next poll.
        return;
      }
      const data = (await res.json()) as {
        notifications: NotificationRow[];
        unread_count: number;
      };
      setItems(data.notifications);
      setUnread(data.unread_count);
    } finally {
      setLoaded(true);
    }
  }, []);

  // Initial + polling. Pause when the tab isn't visible so we don't
  // burn battery and API quota on a backgrounded tab.
  useEffect(() => {
    let alive = true;
    void load();

    function schedule() {
      if (pollingRef.current != null) return;
      pollingRef.current = window.setInterval(() => {
        if (!alive) return;
        if (typeof document !== "undefined" && document.hidden) return;
        void load();
      }, POLL_MS);
    }
    function stop() {
      if (pollingRef.current != null) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }

    schedule();
    function onVis() {
      if (!document.hidden) void load();
    }
    document.addEventListener("visibilitychange", onVis);

    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // Close the dropdown on outside click / escape.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const root = containerRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  async function markRead(id: string) {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)),
    );
    setUnread((u) => Math.max(0, u - 1));
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    });
  }

  async function markAllRead() {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));
    setUnread(0);
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: "all" }),
    });
  }

  return (
    <div
      ref={containerRef}
      className={"relative inline-flex items-center " + (className ?? "")}
    >
      <button
        type="button"
        aria-label={unread > 0 ? `${unread} unread notifications` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="h-7 w-7 rounded-md inline-flex items-center justify-center text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
        >
          <path
            d="M3 11.2V7.5a5 5 0 0 1 10 0v3.7l1 1.3H2l1-1.3ZM6 13.5a2 2 0 0 0 4 0"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 ? (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-lumo-accent text-lumo-accent-ink text-[9px] font-semibold px-1 inline-flex items-center justify-center"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[34px] w-[320px] max-h-[420px] overflow-y-auto rounded-xl border border-lumo-hair bg-lumo-surface shadow-xl z-40"
        >
          <div className="sticky top-0 flex items-center justify-between border-b border-lumo-hair bg-lumo-surface/95 backdrop-blur px-3 py-2">
            <span className="text-[12px] font-semibold text-lumo-fg">
              Notifications
            </span>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="text-[11px] text-lumo-fg-mid hover:text-lumo-fg"
              >
                Mark all read
              </button>
            ) : null}
          </div>

          {!loaded ? (
            <div className="px-3 py-6 text-[12.5px] text-lumo-fg-mid text-center">
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <div className="text-[13px] text-lumo-fg">You&apos;re all caught up.</div>
              <div className="text-[11.5px] text-lumo-fg-low mt-1">
                Lumo will nudge you here when something needs attention.
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-lumo-hair">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!n.read_at) void markRead(n.id);
                    }}
                    className={
                      "w-full text-left px-3 py-2.5 hover:bg-lumo-elevated transition-colors " +
                      (n.read_at ? "opacity-70" : "")
                    }
                  >
                    <div className="flex items-start gap-2">
                      {!n.read_at ? (
                        <span
                          aria-hidden
                          className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-lumo-accent"
                        />
                      ) : (
                        <span aria-hidden className="mt-[6px] h-1.5 w-1.5 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] text-lumo-fg truncate">
                          {n.title}
                        </div>
                        {n.body ? (
                          <div className="text-[11.5px] text-lumo-fg-mid mt-0.5 line-clamp-2">
                            {n.body}
                          </div>
                        ) : null}
                        <div className="text-[10.5px] text-lumo-fg-low mt-1">
                          {relativeTime(n.created_at)}
                        </div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="sticky bottom-0 border-t border-lumo-hair bg-lumo-surface/95 backdrop-blur px-3 py-2 text-right">
            <Link
              href="/memory"
              className="text-[11px] text-lumo-fg-mid hover:text-lumo-fg"
            >
              Memory & settings →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
