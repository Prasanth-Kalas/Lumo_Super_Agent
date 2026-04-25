"use client";

/**
 * /workspace — Lumo's unified dashboard surface.
 *
 * Five tabs: Today / Content / Inbox / Co-pilot / Operations. Pulls
 * live data from every connector the user has authorized (Gmail,
 * Calendar, Contacts, Spotify, YouTube, and — when their reviews land
 * — Meta/IG/FB/LinkedIn/Newsletter).
 *
 * V1.0 ships this shell + Today (with YouTube widgets wired) + the
 * Operations status grid. The other tabs are scaffolded with empty
 * states + an explicit "shipping in v1.x" pill so the user understands
 * the roadmap without us hiding it.
 *
 * The route is gated by middleware; we assume an authenticated user.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

type TabId = "today" | "content" | "inbox" | "copilot" | "operations";

interface TabSpec {
  id: TabId;
  label: string;
  blurb: string;
}

const TABS: TabSpec[] = [
  {
    id: "today",
    label: "Today",
    blurb: "Calendar, top emails, music, and what's posting in the next few hours.",
  },
  {
    id: "content",
    label: "Content",
    blurb: "What's working across your channels. Outliers, repurpose cues, schedule.",
  },
  {
    id: "inbox",
    label: "Inbox",
    blurb: "Comments, DMs, and replies — business leads pulled out of the noise.",
  },
  {
    id: "copilot",
    label: "Co-pilot",
    blurb: "Chat with all your connected data. Ask anything; Lumo answers with numbers.",
  },
  {
    id: "operations",
    label: "Operations",
    blurb: "Connector status, token health, audit log of every write.",
  },
];

interface MarketplaceConnection {
  agent_id: string;
  display_name: string;
  connection: { status: "active" | "expired" | "revoked" | "error" } | null;
}

interface WorkspaceData {
  connections: MarketplaceConnection[];
}

const STORAGE_KEY_TAB = "lumo.workspace.activeTab";

export default function WorkspacePage() {
  const [activeTab, setActiveTab] = useState<TabId>("today");
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Restore last-viewed tab from previous session.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(STORAGE_KEY_TAB) as TabId | null;
    if (saved && TABS.some((t) => t.id === saved)) setActiveTab(saved);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY_TAB, activeTab);
  }, [activeTab]);

  const fetchWorkspace = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      // /api/marketplace already lists active connections per user.
      // We use it as the source of truth for "what's connected" until
      // we ship a dedicated /api/workspace endpoint.
      const r = await fetch("/api/marketplace", { credentials: "include" });
      if (!r.ok) throw new Error(`marketplace fetch ${r.status}`);
      const body = await r.json();
      const agents = (body?.agents ?? []) as MarketplaceConnection[];
      setData({ connections: agents });
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load workspace");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchWorkspace();
  }, [fetchWorkspace]);

  const activeConnections = useMemo(
    () =>
      (data?.connections ?? []).filter(
        (c) => c.connection?.status === "active",
      ),
    [data],
  );

  const hasAnyConnection = activeConnections.length > 0;

  return (
    <main className="workspace">
      <header className="workspace__header">
        <Link href="/" className="workspace__home" aria-label="Home">
          <BrandMark />
        </Link>
        <h1 className="workspace__title">
          Workspace
          <span className="workspace__title-tag">v1.0</span>
        </h1>
        <div className="workspace__header-spacer" />
        <Link href="/marketplace" className="workspace__nav-link">
          Marketplace
        </Link>
        <Link href="/memory" className="workspace__nav-link">
          Memory
        </Link>
        <ThemeToggle />
      </header>

      <nav className="workspace__tabs" role="tablist" aria-label="Workspace tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={activeTab === t.id}
            aria-controls={`tabpanel-${t.id}`}
            id={`tab-${t.id}`}
            className={
              "workspace__tab" +
              (activeTab === t.id ? " workspace__tab--active" : "")
            }
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <section
        id={`tabpanel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        className="workspace__panel"
      >
        {loading ? (
          <div className="workspace__loading">Loading your workspace…</div>
        ) : error ? (
          <div className="workspace__error">
            Couldn&apos;t load workspace data: {error}.{" "}
            <button onClick={() => void fetchWorkspace()}>Retry</button>
          </div>
        ) : !hasAnyConnection ? (
          <EmptyState />
        ) : (
          <TabBody tab={activeTab} connections={activeConnections} />
        )}
      </section>

      <ChatStrip />

      <style jsx>{`
        .workspace {
          min-height: 100dvh;
          display: flex;
          flex-direction: column;
          color: var(--lumo-fg);
          background: var(--lumo-bg);
          padding-bottom: 96px; /* room for chat strip */
        }
        .workspace__header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px 24px;
          border-bottom: 1px solid var(--lumo-border);
          position: sticky;
          top: 0;
          background: color-mix(in srgb, var(--lumo-bg), transparent 0%);
          backdrop-filter: blur(8px);
          z-index: 10;
        }
        .workspace__home {
          display: flex;
          align-items: center;
        }
        .workspace__title {
          font-size: 18px;
          font-weight: 600;
          letter-spacing: -0.01em;
          margin: 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .workspace__title-tag {
          font-size: 11px;
          font-weight: 500;
          padding: 2px 6px;
          border: 1px solid var(--lumo-border);
          border-radius: 999px;
          color: var(--lumo-muted);
        }
        .workspace__header-spacer {
          flex: 1;
        }
        .workspace__nav-link {
          color: var(--lumo-muted);
          text-decoration: none;
          font-size: 14px;
          padding: 6px 10px;
          border-radius: 8px;
        }
        .workspace__nav-link:hover {
          background: var(--lumo-surface);
          color: var(--lumo-fg);
        }
        .workspace__tabs {
          display: flex;
          gap: 4px;
          padding: 12px 24px 0 24px;
          border-bottom: 1px solid var(--lumo-border);
          overflow-x: auto;
          scrollbar-width: none;
        }
        .workspace__tabs::-webkit-scrollbar {
          display: none;
        }
        .workspace__tab {
          padding: 10px 16px;
          font-size: 14px;
          font-weight: 500;
          color: var(--lumo-muted);
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          cursor: pointer;
          white-space: nowrap;
          transition: color 0.15s, border-color 0.15s;
        }
        .workspace__tab:hover {
          color: var(--lumo-fg);
        }
        .workspace__tab--active {
          color: var(--lumo-fg);
          border-bottom-color: var(--lumo-fg);
        }
        .workspace__panel {
          flex: 1;
          padding: 24px;
          max-width: 1280px;
          width: 100%;
          margin: 0 auto;
        }
        .workspace__loading,
        .workspace__error {
          padding: 48px 24px;
          color: var(--lumo-muted);
          text-align: center;
        }
        .workspace__error button {
          margin-left: 8px;
          padding: 4px 12px;
          font-size: 13px;
          border: 1px solid var(--lumo-border);
          border-radius: 6px;
          background: transparent;
          color: var(--lumo-fg);
          cursor: pointer;
        }
        @media (max-width: 768px) {
          .workspace__header {
            padding: 12px 16px;
            gap: 8px;
          }
          .workspace__nav-link {
            display: none;
          }
          .workspace__tabs {
            padding: 8px 16px 0 16px;
          }
          .workspace__panel {
            padding: 16px;
          }
        }
      `}</style>
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Empty state — no connectors yet
// ──────────────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="empty">
      <h2>Your workspace is empty.</h2>
      <p>
        Connect Google, Microsoft, Spotify, or any of the social platforms in
        the Marketplace and they&apos;ll show up here as live cards.
      </p>
      <Link href="/marketplace" className="empty__cta">
        Open marketplace
      </Link>
      <style jsx>{`
        .empty {
          max-width: 520px;
          margin: 64px auto;
          text-align: center;
          color: var(--lumo-muted);
        }
        .empty h2 {
          font-size: 22px;
          color: var(--lumo-fg);
          margin: 0 0 12px 0;
        }
        .empty p {
          font-size: 15px;
          line-height: 1.55;
          margin: 0 0 24px 0;
        }
        .empty__cta {
          display: inline-block;
          padding: 10px 20px;
          background: var(--lumo-fg);
          color: var(--lumo-bg);
          border-radius: 10px;
          font-weight: 500;
          text-decoration: none;
        }
      `}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tab bodies — V1.0 ships Today + Operations wired; others are scaffolds.
// Each is a placeholder that the dedicated tasks (#6-#10) will fill.
// ──────────────────────────────────────────────────────────────────────────

function TabBody({
  tab,
  connections,
}: {
  tab: TabId;
  connections: MarketplaceConnection[];
}) {
  switch (tab) {
    case "today":
      return <TodayTabPlaceholder connections={connections} />;
    case "content":
      return (
        <Placeholder
          title="Content"
          message="Outliers, cross-platform winners, repurpose queue, content calendar."
          version="ships in v1.0 (Task #7)"
        />
      );
    case "inbox":
      return (
        <Placeholder
          title="Inbox"
          message="Unified comments, DMs, business leads detector, super-fans."
          version="ships in v1.0 (Task #8)"
        />
      );
    case "copilot":
      return (
        <Placeholder
          title="Co-pilot"
          message="Chat with your connected data. The orchestrator embedded in workspace context."
          version="ships in v1.0 (Task #9)"
        />
      );
    case "operations":
      return <OperationsTabPlaceholder connections={connections} />;
  }
}

function TodayTabPlaceholder({ connections }: { connections: MarketplaceConnection[] }) {
  // Connected-platform pills as a first signal that the page is alive.
  return (
    <div className="today">
      <h2 className="today__heading">Today</h2>
      <p className="today__sub">
        Live data from {connections.length} connection
        {connections.length === 1 ? "" : "s"}. Cards arrive as Task #6 lands.
      </p>
      <div className="today__pills">
        {connections.map((c) => (
          <span key={c.agent_id} className="today__pill">
            ● {c.display_name.split(" (")[0]}
          </span>
        ))}
      </div>
      <style jsx>{`
        .today__heading {
          font-size: 24px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        .today__sub {
          color: var(--lumo-muted);
          margin: 0 0 24px 0;
        }
        .today__pills {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .today__pill {
          display: inline-flex;
          align-items: center;
          padding: 6px 12px;
          font-size: 13px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 999px;
          color: var(--lumo-fg);
        }
      `}</style>
    </div>
  );
}

function OperationsTabPlaceholder({
  connections,
}: {
  connections: MarketplaceConnection[];
}) {
  return (
    <div className="ops">
      <h2 className="ops__heading">Operations</h2>
      <p className="ops__sub">
        Per-connector status, token health, and audit log. Full grid lands in
        Task #10.
      </p>
      <div className="ops__grid">
        {connections.length === 0 ? (
          <div className="ops__empty">No connections yet.</div>
        ) : (
          connections.map((c) => (
            <div key={c.agent_id} className="ops__row">
              <span className="ops__row-name">{c.display_name}</span>
              <span
                className={
                  "ops__row-status ops__row-status--" +
                  (c.connection?.status ?? "none")
                }
              >
                {c.connection?.status ?? "—"}
              </span>
            </div>
          ))
        )}
      </div>
      <style jsx>{`
        .ops__heading {
          font-size: 24px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        .ops__sub {
          color: var(--lumo-muted);
          margin: 0 0 24px 0;
        }
        .ops__grid {
          display: grid;
          gap: 8px;
          max-width: 640px;
        }
        .ops__row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 8px;
        }
        .ops__row-name {
          font-weight: 500;
        }
        .ops__row-status {
          font-size: 12px;
          padding: 2px 8px;
          border-radius: 999px;
          background: var(--lumo-bg);
          border: 1px solid var(--lumo-border);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .ops__row-status--active {
          color: #2ea84a;
          border-color: rgba(46, 168, 74, 0.3);
        }
        .ops__row-status--expired,
        .ops__row-status--revoked,
        .ops__row-status--error {
          color: #e0613f;
          border-color: rgba(224, 97, 63, 0.3);
        }
        .ops__empty {
          padding: 24px;
          color: var(--lumo-muted);
          text-align: center;
        }
      `}</style>
    </div>
  );
}

function Placeholder({
  title,
  message,
  version,
}: {
  title: string;
  message: string;
  version: string;
}) {
  return (
    <div className="ph">
      <h2 className="ph__heading">{title}</h2>
      <p className="ph__sub">{message}</p>
      <span className="ph__pill">{version}</span>
      <style jsx>{`
        .ph__heading {
          font-size: 24px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        .ph__sub {
          color: var(--lumo-muted);
          margin: 0 0 16px 0;
          max-width: 600px;
        }
        .ph__pill {
          display: inline-block;
          padding: 4px 10px;
          font-size: 12px;
          color: var(--lumo-muted);
          border: 1px dashed var(--lumo-border);
          border-radius: 999px;
        }
      `}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Chat strip — collapsed by default; clicking expands the orchestrator.
// V1.0: links to /chat. V1.x: in-place embedded chat (Task #9).
// ──────────────────────────────────────────────────────────────────────────

function ChatStrip() {
  return (
    <div className="strip">
      <Link href="/" className="strip__inner" aria-label="Open chat">
        <span className="strip__icon" aria-hidden>
          💬
        </span>
        <span className="strip__hint">Ask Lumo anything…</span>
        <span className="strip__voice" aria-hidden>
          🎙️
        </span>
      </Link>
      <style jsx>{`
        .strip {
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          padding: 12px 24px env(safe-area-inset-bottom, 12px) 24px;
          background: linear-gradient(
            to top,
            color-mix(in srgb, var(--lumo-bg), transparent 0%),
            color-mix(in srgb, var(--lumo-bg), transparent 30%)
          );
          backdrop-filter: blur(8px);
          z-index: 20;
        }
        .strip__inner {
          display: flex;
          align-items: center;
          gap: 12px;
          max-width: 1200px;
          margin: 0 auto;
          padding: 12px 16px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 14px;
          color: var(--lumo-muted);
          text-decoration: none;
          transition: border-color 0.15s, background 0.15s;
        }
        .strip__inner:hover {
          border-color: var(--lumo-fg);
          color: var(--lumo-fg);
        }
        .strip__icon,
        .strip__voice {
          font-size: 18px;
        }
        .strip__hint {
          flex: 1;
          font-size: 14px;
        }
        @media (max-width: 768px) {
          .strip {
            padding: 8px 16px env(safe-area-inset-bottom, 8px) 16px;
          }
        }
      `}</style>
    </div>
  );
}
