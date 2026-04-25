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

interface SubAccount {
  id: string;
  agent_id: string;
  external_account_id: string;
  display_name: string;
  avatar_url: string | null;
  account_type: string;
  is_workspace_default: boolean;
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
        <ChannelSelector />
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
  return <TodayTab connections={connections} />;
}

interface TodayCardEnvelope {
  source: "live" | "cached" | "stale" | "error";
  age_ms: number;
  error?: string;
}
interface TodayCalendarEvent {
  id: string;
  title: string;
  start_iso: string;
  end_iso?: string;
  location?: string;
  attendees_count: number;
  source: "google" | "microsoft";
}
interface TodayEmail {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  received_iso: string;
  source: "gmail" | "outlook";
  unread: boolean;
}
interface TodaySpotify {
  is_playing: boolean;
  track_name?: string;
  artist?: string;
  album_art_url?: string;
}
interface TodayYouTubeChannel {
  channel_id: string;
  channel_title: string;
  recent_videos: Array<{
    id: string;
    title: string;
    views?: number;
    published_at: string;
    thumbnail_url?: string;
  }>;
}
interface TodayEnvelope {
  generated_at: string;
  calendar: { events: TodayCalendarEvent[] } & TodayCardEnvelope;
  email: { messages: TodayEmail[] } & TodayCardEnvelope;
  spotify: { now_playing: TodaySpotify | null } & TodayCardEnvelope;
  youtube: { channels: TodayYouTubeChannel[] } & TodayCardEnvelope;
}

function TodayTab({ connections }: { connections: MarketplaceConnection[] }) {
  const [data, setData] = useState<TodayEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const r = await fetch("/api/workspace/today", { credentials: "include" });
      if (!r.ok) throw new Error(`workspace/today ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasGoogle = connections.some((c) => c.agent_id === "google" && c.connection?.status === "active");
  const hasMicrosoft = connections.some((c) => c.agent_id === "microsoft" && c.connection?.status === "active");
  const hasSpotify = connections.some((c) => c.agent_id === "spotify" && c.connection?.status === "active");

  return (
    <div className="today">
      <header className="today__header">
        <h2 className="today__heading">Today</h2>
        <button className="today__refresh" onClick={() => void refresh()}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p className="today__sub">
        {data
          ? `Updated ${new Date(data.generated_at).toLocaleTimeString()}`
          : "Loading your live data…"}
      </p>

      {error && (
        <div className="today__error">Couldn&apos;t load all cards: {error}</div>
      )}

      <div className="today__grid">
        <CalendarCard envelope={data?.calendar} hasAny={hasGoogle || hasMicrosoft} />
        <EmailCard envelope={data?.email} hasAny={hasGoogle || hasMicrosoft} />
        <SpotifyCard envelope={data?.spotify} hasAny={hasSpotify} />
        <YouTubeCard envelope={data?.youtube} hasAny={hasGoogle} />
      </div>

      <style jsx>{`
        .today__header {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .today__heading {
          font-size: 24px;
          font-weight: 600;
          margin: 0;
        }
        .today__refresh {
          margin-left: auto;
          padding: 6px 12px;
          font-size: 12px;
          background: transparent;
          color: var(--lumo-muted);
          border: 1px solid var(--lumo-border);
          border-radius: 8px;
          cursor: pointer;
        }
        .today__refresh:hover {
          color: var(--lumo-fg);
        }
        .today__sub {
          color: var(--lumo-muted);
          margin: 4px 0 24px 0;
          font-size: 13px;
        }
        .today__error {
          padding: 10px 12px;
          background: color-mix(in srgb, #e0613f 12%, transparent);
          color: #e0613f;
          border-radius: 8px;
          margin-bottom: 16px;
          font-size: 13px;
        }
        .today__grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 16px;
        }
      `}</style>
    </div>
  );
}

function SourcePill({ source, age_ms }: { source?: TodayCardEnvelope["source"]; age_ms?: number }) {
  if (!source || source === "live") return null;
  const minutes = age_ms ? Math.floor(age_ms / 60_000) : 0;
  const label =
    source === "cached"
      ? `Cached ${minutes}m ago`
      : source === "stale"
        ? `Stale · ${minutes}m old`
        : "Error";
  const color = source === "stale" || source === "error" ? "#e0613f" : "var(--lumo-muted)";
  return (
    <span className="src-pill" style={{ color, borderColor: color }}>
      {label}
      <style jsx>{`
        .src-pill {
          display: inline-block;
          padding: 2px 6px;
          font-size: 10px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border: 1px solid;
          border-radius: 999px;
          margin-left: 8px;
        }
      `}</style>
    </span>
  );
}

function Card({
  title,
  envelope,
  hasAny,
  emptyConnect,
  children,
}: {
  title: string;
  envelope?: TodayCardEnvelope;
  hasAny: boolean;
  emptyConnect: { label: string; href: string };
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <header className="card__head">
        <h3 className="card__title">{title}</h3>
        <SourcePill source={envelope?.source} age_ms={envelope?.age_ms} />
      </header>
      {!hasAny ? (
        <div className="card__empty">
          <p>Connect a service to populate this card.</p>
          <Link href={emptyConnect.href} className="card__connect">
            {emptyConnect.label}
          </Link>
        </div>
      ) : (
        <div className="card__body">{children}</div>
      )}
      <style jsx>{`
        .card {
          padding: 16px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
        }
        .card__head {
          display: flex;
          align-items: center;
          margin-bottom: 12px;
        }
        .card__title {
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--lumo-muted);
          margin: 0;
        }
        .card__body {
          font-size: 14px;
        }
        .card__empty {
          padding: 8px 0;
          color: var(--lumo-muted);
          font-size: 13px;
        }
        .card__connect {
          display: inline-block;
          margin-top: 8px;
          padding: 6px 10px;
          background: var(--lumo-fg);
          color: var(--lumo-bg);
          border-radius: 6px;
          font-size: 12px;
          text-decoration: none;
        }
      `}</style>
    </section>
  );
}

function CalendarCard({ envelope, hasAny }: { envelope?: TodayEnvelope["calendar"]; hasAny: boolean }) {
  const events = envelope?.events ?? [];
  return (
    <Card title="Next on your calendar" envelope={envelope} hasAny={hasAny} emptyConnect={{ label: "Connect Google or Microsoft", href: "/marketplace" }}>
      {events.length === 0 ? (
        <p className="muted">Nothing in the next 30 days.</p>
      ) : (
        <ul className="rows">
          {events.map((e) => (
            <li key={e.id} className="row">
              <div className="row__title">{e.title}</div>
              <div className="row__sub">
                {formatEventTime(e.start_iso)}
                {e.location && ` · ${e.location}`}
                {e.attendees_count > 0 && ` · ${e.attendees_count} attendees`}
              </div>
            </li>
          ))}
        </ul>
      )}
      <style jsx>{`
        .muted { color: var(--lumo-muted); margin: 0; }
        .rows { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
        .row__title { font-weight: 500; font-size: 14px; }
        .row__sub { color: var(--lumo-muted); font-size: 12px; margin-top: 2px; }
      `}</style>
    </Card>
  );
}

function EmailCard({ envelope, hasAny }: { envelope?: TodayEnvelope["email"]; hasAny: boolean }) {
  const messages = envelope?.messages ?? [];
  return (
    <Card title="Top unread" envelope={envelope} hasAny={hasAny} emptyConnect={{ label: "Connect Google or Microsoft", href: "/marketplace" }}>
      {messages.length === 0 ? (
        <p className="muted">Inbox zero. Nice.</p>
      ) : (
        <ul className="rows">
          {messages.map((m) => (
            <li key={m.id} className="row">
              <div className="row__title">{m.subject}</div>
              <div className="row__sub">
                {m.from} · {formatRelative(m.received_iso)}
              </div>
              <div className="row__snippet">{m.snippet}</div>
            </li>
          ))}
        </ul>
      )}
      <style jsx>{`
        .muted { color: var(--lumo-muted); margin: 0; }
        .rows { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
        .row__title { font-weight: 500; font-size: 14px; line-height: 1.3; }
        .row__sub { color: var(--lumo-muted); font-size: 12px; margin-top: 2px; }
        .row__snippet { color: var(--lumo-muted); font-size: 13px; margin-top: 4px; line-height: 1.4; max-height: 36px; overflow: hidden; }
      `}</style>
    </Card>
  );
}

function SpotifyCard({ envelope, hasAny }: { envelope?: TodayEnvelope["spotify"]; hasAny: boolean }) {
  const np = envelope?.now_playing;
  return (
    <Card title="Now playing" envelope={envelope} hasAny={hasAny} emptyConnect={{ label: "Connect Spotify", href: "/marketplace" }}>
      {!np || !np.is_playing ? (
        <p className="muted">Nothing playing.</p>
      ) : (
        <div className="np">
          {np.album_art_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={np.album_art_url} alt="" className="np__art" />
          )}
          <div className="np__text">
            <div className="np__track">{np.track_name}</div>
            <div className="np__artist">{np.artist}</div>
          </div>
        </div>
      )}
      <style jsx>{`
        .muted { color: var(--lumo-muted); margin: 0; }
        .np { display: flex; align-items: center; gap: 12px; }
        .np__art { width: 56px; height: 56px; border-radius: 6px; object-fit: cover; }
        .np__track { font-weight: 500; font-size: 14px; }
        .np__artist { color: var(--lumo-muted); font-size: 12px; margin-top: 2px; }
      `}</style>
    </Card>
  );
}

function YouTubeCard({ envelope, hasAny }: { envelope?: TodayEnvelope["youtube"]; hasAny: boolean }) {
  const channels = envelope?.channels ?? [];
  return (
    <Card title="YouTube — recent uploads" envelope={envelope} hasAny={hasAny} emptyConnect={{ label: "Connect Google to add YouTube", href: "/marketplace" }}>
      {channels.length === 0 ? (
        <p className="muted">No YouTube channels found on this Google account.</p>
      ) : (
        channels.map((ch) => (
          <div key={ch.channel_id} className="ch">
            <div className="ch__title">{ch.channel_title}</div>
            <ul className="rows">
              {ch.recent_videos.map((v) => (
                <li key={v.id} className="row">
                  {v.thumbnail_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbnail_url} alt="" className="row__thumb" />
                  )}
                  <div>
                    <div className="row__title">{v.title}</div>
                    <div className="row__sub">
                      {v.views !== undefined ? `${formatCount(v.views)} views · ` : ""}
                      {formatRelative(v.published_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <style jsx>{`
        .muted { color: var(--lumo-muted); margin: 0; }
        .ch { margin-top: 4px; }
        .ch__title { font-size: 12px; color: var(--lumo-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.04em; }
        .rows { list-style: none; padding: 0; margin: 0 0 8px 0; display: grid; gap: 10px; }
        .row { display: flex; gap: 10px; align-items: flex-start; }
        .row__thumb { width: 64px; height: 36px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
        .row__title { font-weight: 500; font-size: 13px; line-height: 1.3; }
        .row__sub { color: var(--lumo-muted); font-size: 11px; margin-top: 2px; font-variant-numeric: tabular-nums; }
      `}</style>
    </Card>
  );
}

function formatEventTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function OperationsTabPlaceholder({
  connections,
}: {
  connections: MarketplaceConnection[];
}) {
  return <OperationsTab fallbackConnections={connections} />;
}

interface OpsConnectorRow {
  agent_id: string;
  status: "active" | "expired" | "revoked" | "error";
  connected_at: string;
  last_used_at: string | null;
  last_refreshed_at: string | null;
  expires_at: string | null;
  expires_in_seconds: number | null;
  scope_count: number;
}
interface OpsAuditRow {
  id: number;
  agent_id: string;
  action_type: string;
  ok: boolean;
  platform_response_code: number | null;
  content_excerpt: string | null;
  created_at: string;
  origin: string;
  error_text: string | null;
}
interface OpsCacheRow {
  agent_id: string;
  rows: number;
  newest_fetched_at: string | null;
}
interface OpsEnvelope {
  generated_at: string;
  connectors: OpsConnectorRow[];
  audit: OpsAuditRow[];
  cache: OpsCacheRow[];
}

function OperationsTab({ fallbackConnections }: { fallbackConnections: MarketplaceConnection[] }) {
  const [data, setData] = useState<OpsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const r = await fetch("/api/workspace/operations", { credentials: "include" });
      if (!r.ok) throw new Error(`workspace/operations ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connectors = data?.connectors ?? [];
  const audit = data?.audit ?? [];
  const cacheByAgent = useMemo(() => {
    const m = new Map<string, OpsCacheRow>();
    for (const c of data?.cache ?? []) m.set(c.agent_id, c);
    return m;
  }, [data]);
  const displayMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of fallbackConnections) m.set(c.agent_id, c.display_name);
    return m;
  }, [fallbackConnections]);

  return (
    <div className="ops">
      <header className="ops__header">
        <h2 className="ops__heading">Operations</h2>
        <button className="ops__refresh" onClick={() => void refresh()}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p className="ops__sub">
        Token health, cache size, and an audit trail of every write Lumo
        performed on your behalf.
      </p>

      {error && <div className="ops__error">Couldn&apos;t load: {error}</div>}

      <h3 className="ops__h">Connector status</h3>
      <div className="ops__table">
        <div className="ops__th">
          <span>Platform</span>
          <span>Status</span>
          <span>Token expires</span>
          <span>Last used</span>
          <span>Cache</span>
          <span>Action</span>
        </div>
        {connectors.length === 0 ? (
          <div className="ops__empty">No connections yet.</div>
        ) : (
          connectors.map((c) => {
            const cache = cacheByAgent.get(c.agent_id);
            const exp = c.expires_in_seconds;
            const expClass =
              exp === null
                ? "ok"
                : exp < 300
                  ? "warn"
                  : exp < 3600
                    ? "soon"
                    : "ok";
            return (
              <div key={c.agent_id} className="ops__tr">
                <span className="ops__cell-name">{displayMap.get(c.agent_id) ?? c.agent_id}</span>
                <span className={`ops__pill ops__pill--${c.status}`}>{c.status}</span>
                <span className={`ops__exp ops__exp--${expClass}`}>
                  {exp === null ? "—" : exp <= 0 ? "expired" : formatDuration(exp)}
                </span>
                <span className="ops__cell-muted">
                  {c.last_used_at ? formatRelative(c.last_used_at) : "never"}
                </span>
                <span className="ops__cell-muted tabular-nums">
                  {cache ? `${cache.rows} rows` : "—"}
                </span>
                <span>
                  {(c.status === "expired" || (exp !== null && exp <= 300)) ? (
                    <Link href={`/connections?reauth=${c.agent_id}`} className="ops__action">
                      Re-auth
                    </Link>
                  ) : (
                    <Link href="/connections" className="ops__action ops__action--ghost">
                      Manage
                    </Link>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>

      <h3 className="ops__h">Audit log — last 30 writes</h3>
      <div className="ops__audit">
        {audit.length === 0 ? (
          <p className="ops__empty">No write actions yet.</p>
        ) : (
          <ul className="ops__audit-list">
            {audit.map((a) => (
              <li key={a.id} className={`ops__audit-row ${a.ok ? "ok" : "fail"}`}>
                <span className="ops__audit-time tabular-nums">
                  {new Date(a.created_at).toLocaleString()}
                </span>
                <span className="ops__audit-platform">{a.agent_id}</span>
                <span className="ops__audit-action">{a.action_type}</span>
                <span className="ops__audit-origin">{a.origin}</span>
                <span className={`ops__audit-status ops__audit-status--${a.ok ? "ok" : "fail"}`}>
                  {a.ok ? "ok" : `failed${a.platform_response_code ? ` (${a.platform_response_code})` : ""}`}
                </span>
                {a.content_excerpt && (
                  <span className="ops__audit-excerpt">&ldquo;{a.content_excerpt.slice(0, 120)}{a.content_excerpt.length > 120 ? "…" : ""}&rdquo;</span>
                )}
                {a.error_text && (
                  <span className="ops__audit-error">{a.error_text}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <style jsx>{`
        .ops__header { display: flex; align-items: center; gap: 12px; }
        .ops__heading { font-size: 24px; font-weight: 600; margin: 0; }
        .ops__refresh {
          margin-left: auto;
          padding: 6px 12px;
          font-size: 12px;
          background: transparent;
          color: var(--lumo-muted);
          border: 1px solid var(--lumo-border);
          border-radius: 8px;
          cursor: pointer;
        }
        .ops__refresh:hover { color: var(--lumo-fg); }
        .ops__sub { color: var(--lumo-muted); margin: 4px 0 24px 0; font-size: 13px; }
        .ops__error { padding: 10px 12px; background: color-mix(in srgb, #e0613f 12%, transparent); color: #e0613f; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
        .ops__h {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--lumo-muted);
          margin: 32px 0 12px;
        }
        .ops__table {
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
          overflow: hidden;
        }
        .ops__th, .ops__tr {
          display: grid;
          grid-template-columns: 1.4fr 0.8fr 1fr 1fr 1fr 0.8fr;
          gap: 12px;
          padding: 12px 16px;
          align-items: center;
          font-size: 13px;
        }
        .ops__th {
          background: var(--lumo-bg);
          color: var(--lumo-muted);
          font-size: 11px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border-bottom: 1px solid var(--lumo-border);
        }
        .ops__tr { border-top: 1px solid var(--lumo-border); }
        .ops__tr:first-of-type { border-top: 0; }
        .ops__cell-name { font-weight: 500; }
        .ops__cell-muted { color: var(--lumo-muted); font-size: 12px; }
        .ops__pill {
          display: inline-block;
          padding: 2px 8px;
          font-size: 10px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border: 1px solid;
          border-radius: 999px;
          width: fit-content;
        }
        .ops__pill--active { color: #2ea84a; border-color: rgba(46,168,74,0.3); }
        .ops__pill--expired, .ops__pill--revoked, .ops__pill--error {
          color: #e0613f; border-color: rgba(224,97,63,0.3);
        }
        .ops__exp--ok { color: var(--lumo-fg); }
        .ops__exp--soon { color: #d59f3a; }
        .ops__exp--warn { color: #e0613f; font-weight: 500; }
        .ops__action {
          display: inline-block;
          padding: 4px 10px;
          background: var(--lumo-fg);
          color: var(--lumo-bg);
          border-radius: 6px;
          font-size: 11px;
          font-weight: 500;
          text-decoration: none;
        }
        .ops__action--ghost {
          background: transparent;
          color: var(--lumo-muted);
          border: 1px solid var(--lumo-border);
        }
        .ops__empty {
          padding: 24px;
          color: var(--lumo-muted);
          text-align: center;
        }
        .ops__audit {
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
        }
        .ops__audit-list { list-style: none; padding: 0; margin: 0; }
        .ops__audit-row {
          display: grid;
          grid-template-columns: 1fr 0.8fr 1fr 0.8fr 0.8fr 2fr;
          gap: 12px;
          padding: 10px 16px;
          font-size: 12px;
          border-top: 1px solid var(--lumo-border);
          align-items: baseline;
        }
        .ops__audit-row:first-of-type { border-top: 0; }
        .ops__audit-row.fail { background: color-mix(in srgb, #e0613f 6%, transparent); }
        .ops__audit-time { color: var(--lumo-muted); }
        .ops__audit-platform { font-weight: 500; }
        .ops__audit-action { color: var(--lumo-muted); }
        .ops__audit-origin { color: var(--lumo-muted); font-size: 11px; }
        .ops__audit-status--ok { color: #2ea84a; }
        .ops__audit-status--fail { color: #e0613f; }
        .ops__audit-excerpt { color: var(--lumo-muted); font-style: italic; grid-column: 1 / -1; padding-left: 0; padding-top: 4px; font-size: 11px; }
        .ops__audit-error { color: #e0613f; grid-column: 1 / -1; font-size: 11px; }
        @media (max-width: 900px) {
          .ops__th, .ops__tr {
            grid-template-columns: 1fr 0.8fr 1fr;
          }
          .ops__th > *:nth-child(n+4),
          .ops__tr > *:nth-child(n+4) { display: none; }
          .ops__audit-row {
            grid-template-columns: 1fr 1fr;
          }
          .ops__audit-row > *:nth-child(n+3) { grid-column: 1 / -1; }
        }
      `}</style>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
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

// ──────────────────────────────────────────────────────────────────────────
// ChannelSelector — multi-account dropdown in the workspace header
// ──────────────────────────────────────────────────────────────────────────

function ChannelSelector() {
  const [accounts, setAccounts] = useState<SubAccount[]>([]);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/workspace/accounts", { credentials: "include" });
        if (!r.ok) return;
        const body = (await r.json()) as { accounts: SubAccount[] };
        if (!cancelled) setAccounts(body.accounts ?? []);
      } catch {
        // Best effort — selector simply hides if accounts can't load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Don't render anything if there's only 0 or 1 account total — selector
  // adds nothing in that case.
  if (accounts.length < 2) return null;

  // Group by agent. The selector only shows when at least one agent has
  // multiple sub-accounts; otherwise the user has nothing to switch
  // between.
  const byAgent = new Map<string, SubAccount[]>();
  for (const a of accounts) {
    const list = byAgent.get(a.agent_id) ?? [];
    list.push(a);
    byAgent.set(a.agent_id, list);
  }
  const hasMulti = Array.from(byAgent.values()).some((list) => list.length > 1);
  if (!hasMulti) return null;

  const defaultsByAgent = new Map<string, SubAccount>();
  for (const [agent, list] of byAgent) {
    const def = list.find((a) => a.is_workspace_default) ?? list[0];
    if (def) defaultsByAgent.set(agent, def);
  }

  async function setActive(account: SubAccount) {
    try {
      setSwitching(account.id);
      const r = await fetch("/api/workspace/accounts", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: account.agent_id,
          external_account_id: account.external_account_id,
        }),
      });
      if (r.ok) {
        setAccounts((cur) =>
          cur.map((a) => ({
            ...a,
            is_workspace_default:
              a.agent_id === account.agent_id ? a.id === account.id : a.is_workspace_default,
          })),
        );
        setOpen(false);
        // Soft refresh — the page will re-fetch /workspace/today on next render.
        // For now, hard reload to redraw cards against the new default account.
        if (typeof window !== "undefined") window.location.reload();
      }
    } finally {
      setSwitching(null);
    }
  }

  // Pick the most-multi agent for the trigger label; show a count badge.
  const triggerAgent = Array.from(byAgent.entries()).find(([, l]) => l.length > 1);
  const triggerLabel = triggerAgent
    ? defaultsByAgent.get(triggerAgent[0])?.display_name ?? "Pick channel"
    : "Channels";

  return (
    <div className="cs">
      <button className="cs__btn" onClick={() => setOpen((o) => !o)}>
        <span className="cs__dot" /> {triggerLabel} ▾
      </button>
      {open && (
        <div className="cs__menu" role="menu">
          {Array.from(byAgent.entries()).map(([agent, list]) => (
            <div key={agent} className="cs__group">
              <div className="cs__group-label">{agent}</div>
              {list.map((a) => (
                <button
                  key={a.id}
                  className={
                    "cs__item" + (a.is_workspace_default ? " cs__item--active" : "")
                  }
                  onClick={() => void setActive(a)}
                  disabled={switching === a.id}
                  role="menuitem"
                >
                  {a.avatar_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.avatar_url} alt="" className="cs__avatar" />
                  )}
                  <span className="cs__name">{a.display_name}</span>
                  {a.is_workspace_default && <span className="cs__check">✓</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <style jsx>{`
        .cs { position: relative; }
        .cs__btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          font-size: 13px;
          background: transparent;
          border: 1px solid var(--lumo-border);
          border-radius: 8px;
          color: var(--lumo-fg);
          cursor: pointer;
        }
        .cs__btn:hover { background: var(--lumo-surface); }
        .cs__dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #2ea84a;
        }
        .cs__menu {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          min-width: 240px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
          box-shadow: 0 8px 24px color-mix(in srgb, var(--lumo-bg), transparent 0%);
          padding: 6px;
          z-index: 50;
        }
        .cs__group { padding: 4px 0; }
        .cs__group-label {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--lumo-muted);
          padding: 4px 10px;
        }
        .cs__item {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 8px 10px;
          background: transparent;
          color: var(--lumo-fg);
          border: none;
          font-size: 13px;
          text-align: left;
          border-radius: 6px;
          cursor: pointer;
        }
        .cs__item:hover:not(:disabled) { background: var(--lumo-bg); }
        .cs__item:disabled { opacity: 0.5; cursor: wait; }
        .cs__item--active { color: #2ea84a; }
        .cs__avatar {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          object-fit: cover;
        }
        .cs__name { flex: 1; }
        .cs__check { color: #2ea84a; }
        @media (max-width: 768px) {
          .cs { display: none; }
        }
      `}</style>
    </div>
  );
}
