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
import { LumoWordmark } from "@/components/BrandMark";
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
          <LumoWordmark height={22} />
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
        ) : activeTab === "today" ? (
          // Today is the welcoming surface — show even when there are
          // zero connections so the user lands on a real hero + platform
          // tiles instead of a stark "your workspace is empty" page.
          <TabBody tab={activeTab} connections={activeConnections} />
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
      return <ContentTab />;
    case "inbox":
      return <InboxTab />;
    case "copilot":
      return <CopilotTab connections={connections} />;
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
  const hasMeta = connections.some((c) => c.agent_id === "meta" && c.connection?.status === "active");
  const totalConnected = [hasGoogle, hasMicrosoft, hasSpotify, hasMeta].filter(Boolean).length;
  const greeting = greetingForHour(new Date().getHours());

  return (
    <div className="today">
      <header className="today__hero">
        <div>
          <div className="today__kicker">{greeting} · {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
          <h2 className="today__heading">Your day, in one place.</h2>
          <p className="today__sub">
            {totalConnected === 0
              ? "Connect a service to start. Cards below show live data the moment you do."
              : `${totalConnected} service${totalConnected === 1 ? "" : "s"} connected · ${data ? `updated ${formatTime(data.generated_at)}` : "syncing…"}`}
          </p>
        </div>
        <button className="today__refresh" onClick={() => void refresh()} disabled={loading}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
            <path d="M2 6.5a4.5 4.5 0 0 1 7.7-3.2M11 6.5a4.5 4.5 0 0 1-7.7 3.2M9.5 1.5v2.5h-2.5M3.5 11.5V9h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </header>

      {error && (
        <div className="today__error">Couldn&apos;t load all cards: {error}</div>
      )}

      <div className="today__grid">
        <CalendarCard envelope={data?.calendar} hasAny={hasGoogle || hasMicrosoft} />
        <EmailCard envelope={data?.email} hasAny={hasGoogle || hasMicrosoft} />
        <SpotifyCard envelope={data?.spotify} hasAny={hasSpotify} />
        <YouTubeCard envelope={data?.youtube} hasAny={hasGoogle} />
      </div>

      {totalConnected === 0 && (
        <section className="today__getstarted">
          <h3 className="today__getstarted-title">Get started — connect a service</h3>
          <p className="today__getstarted-sub">Each connection lights up the card above and adds tools your co-pilot can use.</p>
          <div className="today__platforms">
            <PlatformTile agent_id="google" name="Google" hint="Gmail · Calendar · YouTube · Contacts" accent="#4285F4" />
            <PlatformTile agent_id="microsoft" name="Microsoft" hint="Outlook · Calendar · Contacts" accent="#00A4EF" />
            <PlatformTile agent_id="spotify" name="Spotify" hint="Now playing · playlists · queue" accent="#1ED760" />
            <PlatformTile agent_id="meta" name="Meta" hint="Instagram · Facebook · Messenger" accent="#E1306C" />
          </div>
        </section>
      )}

      <style jsx>{`
        .today__hero {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 8px 0 28px 0;
          margin-bottom: 8px;
          border-bottom: 1px solid var(--lumo-border);
        }
        .today__kicker {
          font-size: 12px;
          color: var(--lumo-muted);
          letter-spacing: 0.02em;
          text-transform: capitalize;
          margin-bottom: 6px;
        }
        .today__heading {
          font-size: 28px;
          font-weight: 600;
          letter-spacing: -0.02em;
          margin: 0;
          line-height: 1.15;
        }
        .today__sub {
          color: var(--lumo-muted);
          margin: 8px 0 0 0;
          font-size: 14px;
          max-width: 580px;
          line-height: 1.5;
        }
        .today__refresh {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 12px;
          font-size: 12px;
          background: var(--lumo-surface);
          color: var(--lumo-fg);
          border: 1px solid var(--lumo-border);
          border-radius: 8px;
          cursor: pointer;
          font-weight: 500;
          flex-shrink: 0;
        }
        .today__refresh:hover { background: color-mix(in srgb, var(--lumo-fg) 5%, var(--lumo-surface)); }
        .today__refresh:disabled { opacity: 0.55; cursor: wait; }
        .today__error {
          padding: 10px 12px;
          background: color-mix(in srgb, #e0613f 12%, transparent);
          color: #e0613f;
          border-radius: 8px;
          margin: 16px 0;
          font-size: 13px;
        }
        .today__grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 14px;
          margin-top: 24px;
        }
        .today__getstarted {
          margin-top: 40px;
          padding: 24px;
          background: color-mix(in srgb, var(--lumo-fg) 3%, var(--lumo-surface));
          border: 1px solid var(--lumo-border);
          border-radius: 14px;
        }
        .today__getstarted-title {
          font-size: 16px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        .today__getstarted-sub {
          color: var(--lumo-muted);
          margin: 0 0 18px 0;
          font-size: 13px;
        }
        .today__platforms {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 10px;
        }
        @media (max-width: 640px) {
          .today__heading { font-size: 22px; }
          .today__hero { flex-direction: column; }
        }
      `}</style>
    </div>
  );
}

function greetingForHour(h: number): string {
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good evening";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function PlatformTile({
  agent_id,
  name,
  hint,
  accent,
}: {
  agent_id: string;
  name: string;
  hint: string;
  accent: string;
}) {
  return (
    <Link href={`/marketplace#${agent_id}`} className="ptile">
      <span className="ptile__dot" style={{ background: accent }} />
      <span className="ptile__body">
        <span className="ptile__name">{name}</span>
        <span className="ptile__hint">{hint}</span>
      </span>
      <span className="ptile__arrow" aria-hidden>→</span>
      <style jsx>{`
        .ptile {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          background: var(--lumo-bg);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
          color: var(--lumo-fg);
          text-decoration: none;
          transition: border-color 0.15s, transform 0.05s;
        }
        .ptile:hover { border-color: var(--lumo-fg); }
        .ptile:active { transform: translateY(1px); }
        .ptile__dot {
          width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
          box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 8%, transparent);
        }
        .ptile__body { display: flex; flex-direction: column; flex: 1; min-width: 0; }
        .ptile__name { font-size: 13px; font-weight: 600; }
        .ptile__hint { font-size: 11px; color: var(--lumo-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ptile__arrow { color: var(--lumo-muted); font-size: 14px; }
      `}</style>
    </Link>
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
  subtitle,
  envelope,
  hasAny,
  emptyConnect,
  accent,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  envelope?: TodayCardEnvelope;
  hasAny: boolean;
  emptyConnect: { label: string; href: string; preview?: string };
  accent: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card__bar" style={{ background: accent }} />
      <header className="card__head">
        <span
          className="card__icon"
          style={{
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            color: accent,
          }}
          aria-hidden
        >
          {icon}
        </span>
        <div className="card__heading">
          <h3 className="card__title">{title}</h3>
          {subtitle && <span className="card__subtitle">{subtitle}</span>}
        </div>
        <SourcePill source={envelope?.source} age_ms={envelope?.age_ms} />
      </header>
      {!hasAny ? (
        <div className="card__empty">
          <div className="card__skeleton" aria-hidden>
            <div className="sk sk--80" />
            <div className="sk sk--60" />
            <div className="sk sk--70" />
          </div>
          <p className="card__empty-msg">
            {emptyConnect.preview ?? "Connect to see live data here."}
          </p>
          <Link
            href={emptyConnect.href}
            className="card__connect"
            style={{
              background: accent,
              boxShadow: `0 8px 22px -10px ${accent}`,
            }}
          >
            {emptyConnect.label}
            <span aria-hidden>→</span>
          </Link>
        </div>
      ) : (
        <div className="card__body">{children}</div>
      )}
      <style jsx>{`
        .card {
          position: relative;
          padding: 20px 18px 18px 18px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 14px;
          overflow: hidden;
          transition: border-color 0.2s, transform 0.05s;
        }
        .card:hover {
          border-color: color-mix(in srgb, var(--lumo-fg) 16%, var(--lumo-border));
        }
        .card__bar {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 3px;
        }
        .card__head {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 14px;
        }
        .card__icon {
          width: 34px;
          height: 34px;
          border-radius: 9px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .card__heading {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-width: 0;
        }
        .card__title {
          font-size: 14px;
          font-weight: 600;
          color: var(--lumo-fg);
          margin: 0;
          line-height: 1.2;
        }
        .card__subtitle {
          font-size: 11px;
          color: var(--lumo-muted);
          margin-top: 2px;
          letter-spacing: 0.01em;
        }
        .card__body {
          font-size: 14px;
        }
        .card__empty {
          color: var(--lumo-muted);
        }
        .card__skeleton {
          display: grid;
          gap: 9px;
          padding: 4px 0 16px 0;
        }
        .sk {
          height: 9px;
          border-radius: 999px;
          background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--lumo-fg) 5%, var(--lumo-bg)),
            color-mix(in srgb, var(--lumo-fg) 11%, var(--lumo-bg)),
            color-mix(in srgb, var(--lumo-fg) 5%, var(--lumo-bg))
          );
          background-size: 200% 100%;
          animation: sk-shimmer 2.6s linear infinite;
        }
        .sk--80 { width: 82%; }
        .sk--70 { width: 68%; }
        .sk--60 { width: 54%; }
        @keyframes sk-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .card__empty-msg {
          margin: 0 0 14px 0;
          font-size: 12.5px;
          line-height: 1.5;
        }
        .card__connect {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          color: #fff;
          border-radius: 9px;
          font-size: 12.5px;
          font-weight: 600;
          text-decoration: none;
          letter-spacing: 0.005em;
          transition: filter 0.15s, transform 0.05s;
        }
        .card__connect:hover { filter: brightness(1.08); }
        .card__connect:active { transform: translateY(1px); }
      `}</style>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Brand-coloured glyphs for each platform card. Stroke-only at currentColor
// so the parent's tinted background reads cleanly.
// ──────────────────────────────────────────────────────────────────────────

const ICON_CALENDAR = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M2 6.5h12M5 1.5v3M11 1.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const ICON_MAIL = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3.5" width="12" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
    <path d="M2.5 4.5l5.5 4 5.5-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ICON_SPOTIFY = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 6.5c2-.6 4-.4 5.7.8M5.3 9c1.6-.4 3.3-.2 4.7.8M5.7 11.2c1.2-.3 2.4-.1 3.4.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
const ICON_YOUTUBE = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="1.8" y="3.8" width="12.4" height="8.4" rx="2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M7 6.4l3 1.6-3 1.6V6.4z" fill="currentColor" />
  </svg>
);

function CalendarCard({ envelope, hasAny }: { envelope?: TodayEnvelope["calendar"]; hasAny: boolean }) {
  const events = envelope?.events ?? [];
  return (
    <Card
      title="Next on your calendar"
      subtitle="Upcoming meetings · Google + Microsoft"
      envelope={envelope}
      hasAny={hasAny}
      accent="#4285F4"
      icon={ICON_CALENDAR}
      emptyConnect={{
        label: "Connect calendar",
        href: "/marketplace",
        preview: "We'll surface your next 5 meetings, attendees, and locations here.",
      }}
    >
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
    <Card
      title="Top unread"
      subtitle="What needs a reply · Gmail + Outlook"
      envelope={envelope}
      hasAny={hasAny}
      accent="#EA4335"
      icon={ICON_MAIL}
      emptyConnect={{
        label: "Connect inbox",
        href: "/marketplace",
        preview: "Your most important unread emails surface here — sender, subject, and snippet.",
      }}
    >
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
    <Card
      title="Now playing"
      subtitle="Live from Spotify"
      envelope={envelope}
      hasAny={hasAny}
      accent="#1ED760"
      icon={ICON_SPOTIFY}
      emptyConnect={{
        label: "Connect Spotify",
        href: "/marketplace",
        preview: "See what's playing right now, queue tracks, and pull recent listens.",
      }}
    >
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
    <Card
      title="YouTube — recent uploads"
      subtitle="Latest from your channels"
      envelope={envelope}
      hasAny={hasAny}
      accent="#FF0033"
      icon={ICON_YOUTUBE}
      emptyConnect={{
        label: "Connect YouTube",
        href: "/marketplace",
        preview: "Recent uploads, view counts, and outliers across all your channels.",
      }}
    >
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
  display_name?: string;
  source?: "oauth" | "system";
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
                <span className="ops__cell-name">
                  {c.display_name ?? displayMap.get(c.agent_id) ?? c.agent_id}
                  {c.source === "system" ? (
                    <span className="ops__tag">System</span>
                  ) : null}
                </span>
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
                  {c.source === "system" ? (
                    <Link href="/connections" className="ops__action ops__action--ghost">
                      Audit
                    </Link>
                  ) : (c.status === "expired" || (exp !== null && exp <= 300)) ? (
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
        .ops__tag { margin-left: 8px; color: var(--lumo-accent); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
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

// ──────────────────────────────────────────────────────────────────────────
// InboxTab — unified comments + business-lead detector
// ──────────────────────────────────────────────────────────────────────────

interface InboxItem {
  id: string;
  platform: "youtube" | "instagram" | "facebook" | "linkedin";
  kind: "comment" | "dm" | "mention";
  author_handle: string;
  author_external_id: string | null;
  text: string;
  permalink_context: string;
  received_iso: string;
  like_count: number;
  lead_score: number;
  lead_reasons: string[];
}
interface InboxRelationshipRow {
  handle: string;
  count: number;
  last_iso: string;
  platforms: string[];
}
interface InboxEnvelope {
  generated_at: string;
  items: InboxItem[];
  business_leads: InboxItem[];
  relationship_index: InboxRelationshipRow[];
  source: "live" | "cached" | "stale" | "error";
  age_ms: number;
  error?: string;
}

function InboxTab() {
  const [data, setData] = useState<InboxEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "leads">("all");

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const r = await fetch("/api/workspace/inbox", { credentials: "include" });
      if (!r.ok) throw new Error(`workspace/inbox ${r.status}`);
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

  const items = filter === "leads" ? data?.business_leads ?? [] : data?.items ?? [];
  const leadCount = data?.business_leads.length ?? 0;
  const totalCount = data?.items.length ?? 0;

  return (
    <div className="ix">
      <header className="ix__head">
        <h2 className="ix__heading">Inbox</h2>
        <button className="ix__refresh" onClick={() => void refresh()}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p className="ix__sub">
        Comments and DMs across your connected platforms — Lumo flags business
        leads, partnership requests, and podcast asks automatically.
      </p>

      {error && <div className="ix__error">Couldn&apos;t load: {error}</div>}

      <div className="ix__layout">
        <aside className="ix__rail">
          <div className="ix__rail-head">Relationship index</div>
          {data?.relationship_index.length ? (
            <ul className="ix__rel">
              {data.relationship_index.map((r) => (
                <li key={r.handle} className="ix__rel-row">
                  <span className="ix__rel-handle">{r.handle}</span>
                  <span className="ix__rel-count tabular-nums">{r.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No interactions yet.</p>
          )}
        </aside>

        <main className="ix__main">
          <div className="ix__filters">
            <button
              className={`ix__chip ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              All ({totalCount})
            </button>
            <button
              className={`ix__chip ${filter === "leads" ? "active" : ""}`}
              onClick={() => setFilter("leads")}
            >
              Business leads ({leadCount})
            </button>
          </div>
          {items.length === 0 ? (
            <p className="muted">
              {filter === "leads"
                ? "No business-lead candidates in the recent window."
                : "No comments or DMs found yet."}
            </p>
          ) : (
            <ul className="ix__list">
              {items.map((it) => (
                <li key={it.id} className={`ix__item ${it.lead_score >= 0.7 ? "lead" : ""}`}>
                  <div className="ix__item-meta">
                    <span className={`ix__platform ix__platform--${it.platform}`}>
                      {it.platform}
                    </span>
                    <span className="ix__author">{it.author_handle}</span>
                    <span className="ix__ago tabular-nums">{formatRelative(it.received_iso)}</span>
                    {it.lead_score >= 0.7 && (
                      <span className="ix__lead">
                        ★ Lead · {it.lead_reasons.slice(0, 2).join(", ")}
                      </span>
                    )}
                  </div>
                  <div className="ix__item-text">{it.text}</div>
                  <div className="ix__item-context">
                    on “{it.permalink_context}”{it.like_count > 0 ? ` · ${it.like_count} likes` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>

      <style jsx>{`
        .ix__head { display: flex; align-items: center; gap: 12px; }
        .ix__heading { font-size: 24px; font-weight: 600; margin: 0; }
        .ix__refresh {
          margin-left: auto;
          padding: 6px 12px;
          font-size: 12px;
          background: transparent;
          color: var(--lumo-muted);
          border: 1px solid var(--lumo-border);
          border-radius: 8px;
          cursor: pointer;
        }
        .ix__refresh:hover { color: var(--lumo-fg); }
        .ix__sub { color: var(--lumo-muted); margin: 4px 0 24px 0; font-size: 13px; }
        .ix__error { padding: 10px 12px; background: color-mix(in srgb, #e0613f 12%, transparent); color: #e0613f; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
        .ix__layout {
          display: grid;
          grid-template-columns: 240px 1fr;
          gap: 16px;
        }
        @media (max-width: 768px) {
          .ix__layout { grid-template-columns: 1fr; }
        }
        .ix__rail {
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
          padding: 14px;
          height: fit-content;
        }
        .ix__rail-head {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--lumo-muted);
          margin-bottom: 10px;
        }
        .ix__rel { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
        .ix__rel-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 8px;
        }
        .ix__rel-handle {
          font-size: 13px;
          color: var(--lumo-fg);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ix__rel-count {
          font-size: 12px;
          color: var(--lumo-muted);
        }
        .ix__filters { display: flex; gap: 6px; margin-bottom: 16px; }
        .ix__chip {
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 500;
          background: transparent;
          color: var(--lumo-muted);
          border: 1px solid var(--lumo-border);
          border-radius: 999px;
          cursor: pointer;
        }
        .ix__chip:hover { color: var(--lumo-fg); }
        .ix__chip.active {
          color: var(--lumo-bg);
          background: var(--lumo-fg);
          border-color: var(--lumo-fg);
        }
        .ix__list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
        .ix__item {
          padding: 14px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
        }
        .ix__item.lead {
          border-color: color-mix(in srgb, #fb923c 50%, var(--lumo-border));
          background: color-mix(in srgb, #fb923c 6%, var(--lumo-surface));
        }
        .ix__item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; margin-bottom: 8px; }
        .ix__platform {
          padding: 2px 8px;
          font-size: 10px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border-radius: 999px;
          border: 1px solid;
        }
        .ix__platform--youtube { color: #ff0033; border-color: rgba(255,0,51,0.3); }
        .ix__platform--instagram { color: #e1306c; border-color: rgba(225,48,108,0.3); }
        .ix__platform--facebook { color: #1877f2; border-color: rgba(24,119,242,0.3); }
        .ix__platform--linkedin { color: #0a66c2; border-color: rgba(10,102,194,0.3); }
        .ix__author { font-weight: 500; color: var(--lumo-fg); font-size: 13px; }
        .ix__ago { color: var(--lumo-muted); }
        .ix__lead { color: #fb923c; font-weight: 600; }
        .ix__item-text {
          font-size: 14px;
          line-height: 1.5;
          color: var(--lumo-fg);
          margin-bottom: 6px;
          word-break: break-word;
        }
        .ix__item-context { font-size: 11px; color: var(--lumo-muted); }
        .muted { color: var(--lumo-muted); }
      `}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ContentTab — outliers + repurpose queue + content schedule
// ──────────────────────────────────────────────────────────────────────────

interface ContentOutlier {
  id: string;
  title: string;
  channel_title: string;
  views: number;
  median_views: number;
  multiplier: number;
  published_at: string;
  thumbnail_url?: string;
}
interface ContentScheduleItem {
  id: string;
  agent_id: string;
  action_type: string;
  status: string;
  scheduled_for: string;
  body_excerpt: string;
  external_account_id: string | null;
  origin: string;
}
interface ContentRepurposeCue {
  source_id: string;
  source_label: string;
  multiplier: number;
  suggestion: string;
  target_platforms: string[];
}
interface ContentEnvelope {
  generated_at: string;
  outliers: ContentOutlier[];
  schedule: ContentScheduleItem[];
  repurpose_cues: ContentRepurposeCue[];
  source: "live" | "cached" | "stale" | "error";
  age_ms: number;
  error?: string;
}

function ContentTab() {
  const [data, setData] = useState<ContentEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const r = await fetch("/api/workspace/content", { credentials: "include" });
      if (!r.ok) throw new Error(`workspace/content ${r.status}`);
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

  return (
    <div className="ct">
      <header className="ct__head">
        <h2 className="ct__heading">Content</h2>
        <button className="ct__refresh" onClick={() => void refresh()}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p className="ct__sub">
        What&apos;s outperforming your median, what to repurpose, and what&apos;s already on
        the schedule.
      </p>

      {error && <div className="ct__error">Couldn&apos;t load: {error}</div>}

      <h3 className="ct__sec">Outliers — beating your median by ≥1.5×</h3>
      <div className="ct__outliers">
        {data && data.outliers.length === 0 && (
          <p className="muted">No outliers in the last 30 uploads. Steady performance — try shipping more variants.</p>
        )}
        {(data?.outliers ?? []).map((o) => (
          <article key={o.id} className="ct__out">
            {o.thumbnail_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={o.thumbnail_url} alt="" className="ct__out-thumb" />
            )}
            <div className="ct__out-body">
              <div className="ct__out-mult tabular-nums">{o.multiplier.toFixed(1)}×</div>
              <div className="ct__out-title">{o.title}</div>
              <div className="ct__out-meta">
                <span className="tabular-nums">{formatCount(o.views)} views</span>
                <span> · median {formatCount(Math.round(o.median_views))}</span>
                <span> · {formatRelative(o.published_at)}</span>
              </div>
            </div>
          </article>
        ))}
      </div>

      <h3 className="ct__sec">Repurpose queue</h3>
      <div className="ct__rep">
        {data && data.repurpose_cues.length === 0 && (
          <p className="muted">No suggestions yet — needs at least one outlier to seed cues.</p>
        )}
        {(data?.repurpose_cues ?? []).map((c) => (
          <article key={c.source_id} className="ct__rep-row">
            <div className="ct__rep-mult tabular-nums">{c.multiplier.toFixed(1)}×</div>
            <div className="ct__rep-text">
              <div className="ct__rep-suggestion">{c.suggestion}</div>
              <div className="ct__rep-targets">
                {c.target_platforms.map((p) => (
                  <span key={p} className="ct__rep-target">{p}</span>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>

      <h3 className="ct__sec">Schedule (next 30 days)</h3>
      <div className="ct__sched">
        {data && data.schedule.length === 0 && (
          <p className="muted">Nothing on the schedule. Drop a queued post from the Co-pilot tab.</p>
        )}
        {(data?.schedule ?? []).map((s) => (
          <article key={s.id} className={`ct__sched-row ct__sched-row--${s.status}`}>
            <span className="ct__sched-when tabular-nums">
              {new Date(s.scheduled_for).toLocaleString()}
            </span>
            <span className="ct__sched-platform">{s.agent_id}</span>
            <span className="ct__sched-action">{s.action_type}</span>
            <span className="ct__sched-status">{s.status}</span>
            <span className="ct__sched-body">{s.body_excerpt}</span>
          </article>
        ))}
      </div>

      <style jsx>{`
        .ct__head { display: flex; align-items: center; gap: 12px; }
        .ct__heading { font-size: 24px; font-weight: 600; margin: 0; }
        .ct__refresh {
          margin-left: auto;
          padding: 6px 12px;
          font-size: 12px;
          background: transparent;
          color: var(--lumo-muted);
          border: 1px solid var(--lumo-border);
          border-radius: 8px;
          cursor: pointer;
        }
        .ct__sub { color: var(--lumo-muted); margin: 4px 0 24px 0; font-size: 13px; }
        .ct__error { padding: 10px 12px; background: color-mix(in srgb, #e0613f 12%, transparent); color: #e0613f; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
        .ct__sec {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--lumo-muted);
          margin: 32px 0 12px;
        }
        .ct__outliers {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 12px;
        }
        .ct__out {
          display: flex;
          gap: 12px;
          padding: 12px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
        }
        .ct__out-thumb {
          width: 96px;
          height: 54px;
          object-fit: cover;
          border-radius: 6px;
          flex-shrink: 0;
        }
        .ct__out-body { flex: 1; min-width: 0; }
        .ct__out-mult {
          display: inline-block;
          padding: 1px 8px;
          font-size: 12px;
          font-weight: 600;
          color: #fb923c;
          background: color-mix(in srgb, #fb923c 12%, transparent);
          border: 1px solid color-mix(in srgb, #fb923c 35%, transparent);
          border-radius: 999px;
          margin-bottom: 4px;
        }
        .ct__out-title {
          font-size: 13px;
          font-weight: 500;
          line-height: 1.3;
          margin-bottom: 4px;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .ct__out-meta { color: var(--lumo-muted); font-size: 11px; }
        .ct__rep {
          display: grid;
          gap: 8px;
        }
        .ct__rep-row {
          display: grid;
          grid-template-columns: 60px 1fr;
          gap: 16px;
          padding: 14px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
        }
        .ct__rep-mult {
          font-size: 16px;
          font-weight: 600;
          color: #fb923c;
        }
        .ct__rep-suggestion {
          font-size: 14px;
          line-height: 1.5;
          margin-bottom: 8px;
        }
        .ct__rep-targets { display: flex; gap: 6px; }
        .ct__rep-target {
          padding: 2px 8px;
          font-size: 10px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          background: var(--lumo-bg);
          border: 1px solid var(--lumo-border);
          border-radius: 999px;
          color: var(--lumo-muted);
        }
        .ct__sched {
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
          overflow: hidden;
        }
        .ct__sched-row {
          display: grid;
          grid-template-columns: 1.4fr 0.8fr 0.8fr 0.6fr 2fr;
          gap: 12px;
          padding: 10px 14px;
          font-size: 12px;
          border-top: 1px solid var(--lumo-border);
          align-items: baseline;
        }
        .ct__sched-row:first-of-type { border-top: 0; }
        .ct__sched-row--pending { background: color-mix(in srgb, #fb923c 6%, transparent); }
        .ct__sched-row--draft { color: var(--lumo-muted); }
        .ct__sched-when { color: var(--lumo-muted); }
        .ct__sched-platform { font-weight: 500; }
        .ct__sched-status { color: var(--lumo-muted); text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
        .ct__sched-body { color: var(--lumo-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @media (max-width: 768px) {
          .ct__sched-row { grid-template-columns: 1fr 1fr; }
          .ct__sched-row > *:nth-child(n+3) { grid-column: 1 / -1; }
        }
        .muted { color: var(--lumo-muted); }
      `}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// CopilotTab — preset prompts + freeform input that hand off to /
// ──────────────────────────────────────────────────────────────────────────

interface PresetPrompt {
  category: string;
  label: string;
  prompt: string;
  needs_agent_id?: string;
}

const ALL_PRESETS: PresetPrompt[] = [
  {
    category: "Calendar",
    label: "What's on my calendar today?",
    prompt: "What's on my calendar today and tomorrow? Include attendees and locations.",
    needs_agent_id: "google",
  },
  {
    category: "Calendar",
    label: "Find a 30-min slot this week with Alex",
    prompt: "Find a 30-minute slot this week when both Alex and I are free. Suggest 3 options.",
    needs_agent_id: "google",
  },
  {
    category: "Email",
    label: "Top unread that need a reply",
    prompt: "Look through my unread email and surface the top 5 that need a personal reply, ranked by urgency.",
    needs_agent_id: "google",
  },
  {
    category: "Email",
    label: "Summarize my morning",
    prompt: "Give me a 60-second briefing on what came in overnight — calendar changes, urgent emails, anything that needs action today.",
    needs_agent_id: "google",
  },
  {
    category: "YouTube",
    label: "Top videos this month",
    prompt: "Which of my YouTube videos performed best this month? Show watch time, traffic source, and audience retention.",
    needs_agent_id: "google",
  },
  {
    category: "YouTube",
    label: "Reply to recent comments",
    prompt: "Look at the last 24 hours of comments on my latest video. Draft replies for the ones that look like business leads or questions worth answering.",
    needs_agent_id: "google",
  },
  {
    category: "YouTube",
    label: "What's working across uploads",
    prompt: "Across my last 30 uploads, what themes or hooks consistently outperform my median? Suggest two video ideas based on the patterns.",
    needs_agent_id: "google",
  },
  {
    category: "Music",
    label: "Set a focus playlist",
    prompt: "Start a focus session — play something instrumental on Spotify and silence notifications for 90 minutes.",
    needs_agent_id: "spotify",
  },
  {
    category: "Cross-platform",
    label: "What should I create next?",
    prompt: "Look at what's working across my YouTube and email subscribers — what should I make next? Give me a hook + platform + format.",
  },
  {
    category: "Cross-platform",
    label: "Repurpose my best post",
    prompt: "Find my best-performing post from the last 30 days across any connected platform. Draft a reel-format version optimized for Instagram.",
  },
];

function CopilotTab({ connections }: { connections: MarketplaceConnection[] }) {
  const [input, setInput] = useState("");
  const activeAgents = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) if (c.connection?.status === "active") set.add(c.agent_id);
    return set;
  }, [connections]);

  const presets = ALL_PRESETS.filter(
    (p) => !p.needs_agent_id || activeAgents.has(p.needs_agent_id),
  );

  function handoff(prompt: string) {
    if (typeof window === "undefined") return;
    const q = encodeURIComponent(prompt);
    window.location.href = `/?q=${q}`;
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (input.trim().length === 0) return;
    handoff(input.trim());
  }

  // Group presets by category for layout.
  const grouped = useMemo(() => {
    const m = new Map<string, PresetPrompt[]>();
    for (const p of presets) {
      const list = m.get(p.category) ?? [];
      list.push(p);
      m.set(p.category, list);
    }
    return Array.from(m.entries());
  }, [presets]);

  return (
    <div className="cp">
      <header className="cp__head">
        <h2 className="cp__heading">Co-pilot</h2>
      </header>
      <p className="cp__sub">
        Ask Lumo anything about your connected data — the orchestrator answers
        with real numbers, drafts replies for your confirmation, or schedules
        actions for later.
      </p>

      <form className="cp__composer" onSubmit={handleSubmit}>
        <input
          className="cp__input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What's on my plate today? · Reply to my latest YouTube comments · Find a 30-min slot with Alex…"
        />
        <button className="cp__submit" type="submit" disabled={input.trim().length === 0}>
          Ask Lumo →
        </button>
      </form>

      <h3 className="cp__sec">Quick prompts</h3>
      {grouped.length === 0 ? (
        <p className="muted">Connect a service to see relevant prompts.</p>
      ) : (
        <div className="cp__groups">
          {grouped.map(([cat, list]) => (
            <div key={cat} className="cp__group">
              <div className="cp__group-label">{cat}</div>
              <div className="cp__chips">
                {list.map((p) => (
                  <button
                    key={p.prompt}
                    className="cp__chip"
                    onClick={() => handoff(p.prompt)}
                    title={p.prompt}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="cp__hint">
        Why? <span className="cp__hint-text">Co-pilot routes you to Lumo&apos;s main chat with the prompt pre-filled. The same orchestrator that powers /workspace also handles voice — open it in a tab and ask anything.</span>
      </p>

      <style jsx>{`
        .cp__head { display: flex; align-items: center; gap: 12px; }
        .cp__heading { font-size: 24px; font-weight: 600; margin: 0; }
        .cp__sub { color: var(--lumo-muted); margin: 4px 0 24px 0; font-size: 13px; }
        .cp__composer {
          display: flex;
          gap: 8px;
          padding: 8px;
          background: var(--lumo-surface);
          border: 1px solid var(--lumo-border);
          border-radius: 12px;
          margin-bottom: 24px;
        }
        .cp__input {
          flex: 1;
          background: transparent;
          color: var(--lumo-fg);
          border: none;
          outline: none;
          font-size: 15px;
          padding: 8px 12px;
        }
        .cp__input::placeholder { color: var(--lumo-muted); }
        .cp__submit {
          padding: 8px 16px;
          background: var(--lumo-fg);
          color: var(--lumo-bg);
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
        }
        .cp__submit:disabled { opacity: 0.4; cursor: not-allowed; }
        .cp__sec {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--lumo-muted);
          margin: 16px 0 12px;
        }
        .cp__groups {
          display: grid;
          gap: 16px;
        }
        .cp__group-label {
          font-size: 11px;
          color: var(--lumo-muted);
          margin-bottom: 8px;
          letter-spacing: 0.04em;
        }
        .cp__chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .cp__chip {
          padding: 8px 14px;
          background: var(--lumo-surface);
          color: var(--lumo-fg);
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
          font-size: 13px;
          text-align: left;
          cursor: pointer;
          transition: border-color 0.15s, background 0.15s;
        }
        .cp__chip:hover {
          border-color: var(--lumo-fg);
          background: color-mix(in srgb, var(--lumo-fg) 6%, var(--lumo-surface));
        }
        .cp__hint {
          margin-top: 32px;
          padding: 12px 14px;
          background: var(--lumo-surface);
          border: 1px dashed var(--lumo-border);
          border-radius: 8px;
          font-size: 12px;
          color: var(--lumo-muted);
          line-height: 1.5;
        }
        .cp__hint-text { color: var(--lumo-muted); }
        .muted { color: var(--lumo-muted); }
      `}</style>
    </div>
  );
}
