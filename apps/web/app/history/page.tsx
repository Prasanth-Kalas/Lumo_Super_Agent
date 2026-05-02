"use client";

/**
 * /history — your past conversations and orders, in one stream.
 *
 * Design: ChatGPT-style single timeline, newest first. Every entry
 * is either a conversation (preview snippet, message count, trip
 * chip if any) or a trip card (title, status, total, leg chips).
 * The two live in the SAME list so the user doesn't have to track
 * which column holds what — time is the primary axis.
 *
 * Filters (top bar):
 *   • All         — default, interleaved
 *   • Conversations
 *   • Trips
 *
 * Search: substring match across conversation previews and trip
 * titles. Debounced lightly; the dataset is small enough that a
 * client-side filter is fine.
 *
 * Selecting a conversation row resumes that session_id in the chat
 * shell (?session=...). Selecting a trip expands the leg detail
 * inline and offers Cancel / refund when the status permits.
 *
 * Data source: GET /api/history. Now properly gated — signed-out
 * users are bounced to /login by middleware, so we can assume the
 * response is the current user's own history.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface TripRow {
  trip_id: string;
  session_id: string;
  status: string;
  payload: {
    trip_title?: string;
    total_amount?: string;
    currency?: string;
    legs?: Array<{
      order: number;
      agent_id: string;
      tool_name?: string;
      summary?: { kind?: string; payload?: unknown };
    }>;
  };
  created_at: string;
  updated_at: string;
  cancel_requested_at: string | null;
}

interface SessionRow {
  session_id: string;
  started_at: string;
  last_activity_at: string;
  user_message_count: number;
  preview: string | null;
  trip_ids: string[];
}

interface HistoryPayload {
  sessions: SessionRow[];
  trips: TripRow[];
}

type TimelineItem =
  | { kind: "session"; at: string; row: SessionRow }
  | { kind: "trip"; at: string; row: TripRow };

type Filter = "all" | "conversations" | "trips";

export default function HistoryPage() {
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [expandedTripId, setExpandedTripId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/history", { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status}`);
        const j = (await res.json()) as HistoryPayload;
        setData(j);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "unknown");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Merge sessions and trips into a single timeline sorted by recency.
  // Sessions use last_activity_at (the last time the conversation
  // saw any event); trips use updated_at so a trip that's still
  // being dispatched surfaces above one that was filed yesterday.
  const timeline = useMemo<TimelineItem[]>(() => {
    if (!data) return [];
    const items: TimelineItem[] = [];
    for (const s of data.sessions) {
      items.push({ kind: "session", at: s.last_activity_at, row: s });
    }
    for (const t of data.trips) {
      items.push({ kind: "trip", at: t.updated_at, row: t });
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return items;
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return timeline.filter((it) => {
      if (filter === "conversations" && it.kind !== "session") return false;
      if (filter === "trips" && it.kind !== "trip") return false;
      if (!q) return true;
      if (it.kind === "session") {
        return (it.row.preview ?? "").toLowerCase().includes(q);
      }
      const title = (it.row.payload.trip_title ?? "").toLowerCase();
      return title.includes(q);
    });
  }, [timeline, filter, query]);

  // Group by day for the dividers. "Today" / "Yesterday" / "This week"
  // / "Month Day" buckets — a familiar pattern that keeps a long
  // scroll orientable.
  const grouped = useMemo(() => groupByDay(filtered), [filtered]);

  const counts = useMemo(() => {
    if (!data) return { sessions: 0, trips: 0 };
    return { sessions: data.sessions.length, trips: data.trips.length };
  }, [data]);

  return (
    <div className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex flex-col">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <Link
              href="/"
              className="flex items-center hover:opacity-90 transition-opacity"
            >
              <LumoWordmark height={22} />
            </Link>
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">
              /
            </span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">
              History
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="text-[12.5px] text-lumo-fg-low hover:text-lumo-fg transition-colors"
            >
              Back to chat
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-6 py-12 flex-1">
        <div className="mb-10 space-y-3">
          <h1 className="font-display text-[44px] md:text-[64px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
            Your <span className="italic text-lumo-accent">history.</span>
          </h1>
          <p className="text-[15px] text-lumo-fg-mid leading-[1.65] max-w-xl">
            Every conversation and every booking, newest first.
          </p>
        </div>

        {/* Filter chips + search. Stays compact; filters take the
            left, search fills the right. */}
        <div className="mb-5 flex items-center gap-3 flex-wrap">
          <div className="inline-flex rounded-full border border-lumo-hair bg-lumo-surface p-0.5">
            <FilterChip
              label="All"
              count={counts.sessions + counts.trips}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            <FilterChip
              label="Conversations"
              count={counts.sessions}
              active={filter === "conversations"}
              onClick={() => setFilter("conversations")}
            />
            <FilterChip
              label="Trips"
              count={counts.trips}
              active={filter === "trips"}
              onClick={() => setFilter("trips")}
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles and snippets…"
              className="w-full h-8 rounded-md border border-lumo-hair bg-lumo-surface px-3 text-[13px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
            />
          </div>
        </div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-20 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse"
              />
            ))}
          </div>
        ) : err ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500">
            Couldn&apos;t load history: {err}. If your admin
            hasn&apos;t configured persistence yet, history
            won&apos;t be available.
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState hasAnyData={(counts.sessions + counts.trips) > 0} query={query} filter={filter} />
        ) : (
          <div className="space-y-8">
            {grouped.map((g) => (
              <section key={g.label} className="space-y-2">
                <div className="font-display italic text-[20px] tracking-[-0.01em] text-lumo-fg-mid sticky top-[60px] bg-lumo-bg/85 backdrop-blur-sm py-2 z-[5]">
                  {g.label}.
                </div>
                <ul className="space-y-2">
                  {g.items.map((it) =>
                    it.kind === "session" ? (
                      <SessionRowCard key={`s-${it.row.session_id}`} row={it.row} />
                    ) : (
                      <TripRowCard
                        key={`t-${it.row.trip_id}`}
                        row={it.row}
                        expanded={expandedTripId === it.row.trip_id}
                        onToggle={() =>
                          setExpandedTripId(
                            expandedTripId === it.row.trip_id
                              ? null
                              : it.row.trip_id,
                          )
                        }
                      />
                    ),
                  )}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-7 px-3 rounded-full text-[12px] transition-colors inline-flex items-center gap-1.5 " +
        (active
          ? "bg-lumo-fg text-lumo-bg"
          : "text-lumo-fg-mid hover:text-lumo-fg")
      }
    >
      {label}
      <span
        className={
          "num text-[11px] " +
          (active ? "text-lumo-bg/70" : "text-lumo-fg-low")
        }
      >
        {count}
      </span>
    </button>
  );
}

/**
 * Conversation row — preview snippet + metadata. Click resumes the
 * session in the chat shell. We use a regular <a> (not <Link>) so
 * the shell does a full reload and gets a clean SSE context.
 */
function SessionRowCard({ row }: { row: SessionRow }) {
  const href = `/?session=${encodeURIComponent(row.session_id)}`;
  return (
    <li>
      <a
        href={href}
        className="group block rounded-2xl border border-lumo-hair bg-lumo-surface px-5 py-4 hover:border-lumo-edge hover:shadow-card-lift transition-all"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {row.trip_ids.length > 0 ? (
                <span className="inline-flex items-center text-[10.5px] text-lumo-accent border border-lumo-accent/30 bg-lumo-accent/5 rounded-full px-1.5 py-0.5">
                  {row.trip_ids.length} trip{row.trip_ids.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[14px] text-lumo-fg line-clamp-2 leading-snug">
              {row.preview ?? (
                <em className="text-lumo-fg-low">(empty session)</em>
              )}
            </div>
            <div className="mt-1 text-[11.5px] text-lumo-fg-low num">
              {fmtRelative(row.last_activity_at)} ·{" "}
              {row.user_message_count} message
              {row.user_message_count === 1 ? "" : "s"}
            </div>
          </div>
          <span
            className="text-lumo-fg-low group-hover:text-lumo-fg group-hover:translate-x-0.5 transition-all shrink-0 mt-1"
            aria-hidden
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M3 7h8m0 0-3-3m3 3-3 3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </a>
    </li>
  );
}

/**
 * Trip row — collapsed shows title / status / total / legs count.
 * Expanded reveals the leg list and cancel action when status
 * permits.
 */
function TripRowCard({
  row,
  expanded,
  onToggle,
}: {
  row: TripRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <div className="rounded-2xl border border-lumo-hair bg-lumo-surface hover:border-lumo-edge transition-all">
        <button
          type="button"
          onClick={onToggle}
          className="w-full text-left px-5 py-4"
          aria-expanded={expanded}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <StatusPill status={row.status} />
              </div>
              <div className="mt-1 text-[14px] text-lumo-fg truncate">
                {row.payload.trip_title ?? "Untitled trip"}
              </div>
              <div className="mt-1 text-[11.5px] text-lumo-fg-low num">
                {fmtRelative(row.updated_at)}
                {row.payload.legs?.length
                  ? ` · ${row.payload.legs.length} leg${
                      row.payload.legs.length === 1 ? "" : "s"
                    }`
                  : ""}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              {row.payload.total_amount ? (
                <div className="text-[14px] text-lumo-fg num">
                  {formatMoney(
                    row.payload.total_amount,
                    row.payload.currency,
                  )}
                </div>
              ) : null}
              <span
                className={
                  "text-lumo-fg-low transition-transform " +
                  (expanded ? "rotate-180" : "")
                }
                aria-hidden
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M3 4.5 6 7.5l3-3"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
          </div>
        </button>
        {expanded ? (
          <div className="border-t border-lumo-hair px-4 py-3">
            <TripDetail trip={row} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function TripDetail({ trip }: { trip: TripRow }) {
  const [cancelState, setCancelState] = useState<
    "idle" | "requesting" | "ok" | "err"
  >("idle");
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
  const canCancel =
    trip.status === "draft" ||
    trip.status === "confirmed" ||
    trip.status === "dispatching" ||
    trip.status === "committed";

  async function doCancel() {
    setCancelState("requesting");
    try {
      const res = await fetch(`/api/trip/${trip.trip_id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "cancelled via history panel" }),
      });
      const j = (await res.json()) as { message?: string; action?: string };
      if (!res.ok && res.status !== 202)
        throw new Error(j.message ?? `${res.status}`);
      setCancelState("ok");
      setCancelMsg(j.message ?? j.action ?? "Cancel recorded.");
    } catch (e) {
      setCancelState("err");
      setCancelMsg(e instanceof Error ? e.message : "unknown");
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-[11.5px] text-lumo-fg-low num">
        Trip {shortTripId(trip.trip_id)} · started{" "}
        {fmtAbs(trip.created_at)}
      </div>

      {trip.payload.legs?.length ? (
        <ul className="divide-y divide-lumo-hair rounded-lg border border-lumo-hair overflow-hidden">
          {trip.payload.legs.map((leg) => (
            <li
              key={leg.order}
              className="flex items-start justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-[12.5px] text-lumo-fg">
                  Leg {leg.order} · {legFriendly(leg.agent_id)}
                </div>
                {leg.tool_name ? (
                  <div className="text-[11.5px] text-lumo-fg-low truncate">
                    {leg.tool_name}
                  </div>
                ) : null}
              </div>
              {legAmount(leg) ? (
                <div className="text-[12.5px] text-lumo-fg num shrink-0">
                  {legAmount(leg)}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href={`/?session=${encodeURIComponent(trip.session_id)}`}
          className="h-7 px-2.5 rounded-md border border-lumo-hair text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors inline-flex items-center gap-1.5"
        >
          Open conversation
        </Link>
        {canCancel ? (
          <button
            type="button"
            onClick={doCancel}
            disabled={cancelState === "requesting"}
            className="h-7 px-2.5 rounded-md border border-lumo-hair text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors disabled:opacity-50"
          >
            {cancelState === "requesting" ? "Cancelling…" : "Cancel / refund"}
          </button>
        ) : null}
        {cancelMsg ? (
          <span
            className={
              "text-[11.5px] " +
              (cancelState === "err" ? "text-red-400" : "text-lumo-fg-low")
            }
          >
            {cancelMsg}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const [label, tone] = statusTone(status);
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] " +
        tone
      }
    >
      {label}
    </span>
  );
}

function EmptyState({
  hasAnyData,
  query,
  filter,
}: {
  hasAnyData: boolean;
  query: string;
  filter: Filter;
}) {
  if (!hasAnyData) {
    return (
      <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-surface/40 p-8 text-center space-y-2">
        <div className="text-[14px] text-lumo-fg">No history yet.</div>
        <div className="text-[12.5px] text-lumo-fg-mid max-w-md mx-auto">
          Once you book something with Lumo, your past
          conversations and orders will appear here. Start by
          asking Lumo anything on the{" "}
          <Link href="/" className="text-lumo-accent hover:underline">
            chat screen
          </Link>
          .
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-surface/40 p-8 text-center space-y-2">
      <div className="text-[14px] text-lumo-fg">No matches.</div>
      <div className="text-[12.5px] text-lumo-fg-mid max-w-md mx-auto">
        {query ? (
          <>
            Nothing matches &ldquo;{query}&rdquo; in {filter}.
          </>
        ) : (
          <>Nothing in this view yet.</>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Grouping + formatting helpers
// ──────────────────────────────────────────────────────────────────

interface Group {
  label: string;
  items: TimelineItem[];
}

/**
 * Bucket items by "Today", "Yesterday", "Earlier this week", then
 * by month-name for older entries. Buckets are created lazily in
 * scan order so the output already mirrors newest-first input.
 */
function groupByDay(items: TimelineItem[]): Group[] {
  const now = new Date();
  const today = startOfDay(now);
  const yday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  const groups: Group[] = [];
  const byLabel = new Map<string, Group>();

  for (const it of items) {
    const d = new Date(it.at);
    let label: string;
    if (sameDay(d, today)) label = "Today";
    else if (sameDay(d, yday)) label = "Yesterday";
    else if (d >= weekStart) label = "Earlier this week";
    else {
      // "April 2026" for older months.
      label = d.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    }
    const existing = byLabel.get(label);
    if (existing) {
      existing.items.push(it);
    } else {
      const g = { label, items: [it] };
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

function statusTone(status: string): [string, string] {
  switch (status) {
    case "committed":
      return [
        "booked",
        "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
      ];
    case "dispatching":
      return [
        "booking…",
        "bg-amber-500/10 text-amber-400 border border-amber-500/20",
      ];
    case "draft":
      return ["draft", "bg-lumo-elevated text-lumo-fg-low border border-lumo-hair"];
    case "confirmed":
      return [
        "confirmed",
        "bg-lumo-accent/10 text-lumo-accent border border-lumo-accent/20",
      ];
    case "rolled_back":
      return [
        "refunded",
        "bg-lumo-elevated text-lumo-fg-low border border-lumo-hair",
      ];
    case "rollback_failed":
      return [
        "needs attention",
        "bg-red-500/10 text-red-400 border border-red-500/20",
      ];
    default:
      return [
        status,
        "bg-lumo-elevated text-lumo-fg-low border border-lumo-hair",
      ];
  }
}

function legFriendly(agent_id: string): string {
  const known: Record<string, string> = {
    "flight-agent": "Flight",
    "lumo.flight": "Flight",
    "hotel-agent": "Hotel",
    "lumo.hotel": "Hotel",
    "food-agent": "Food",
    "lumo.food": "Food",
    "restaurant-agent": "Restaurant",
    "lumo.restaurant": "Restaurant",
  };
  return known[agent_id] ?? agent_id;
}

function legAmount(leg: { summary?: { payload?: unknown } }): string | null {
  if (!leg.summary || typeof leg.summary !== "object") return null;
  const p = (leg.summary.payload ?? {}) as Record<string, unknown>;
  const amt =
    findStringAmount(p, [
      "total_amount",
      "subtotal",
      "total",
      "price",
      "amount",
    ]) ?? null;
  const cur =
    typeof p["currency"] === "string" &&
    /^[A-Z]{3}$/.test(p["currency"] as string)
      ? (p["currency"] as string)
      : null;
  if (!amt) return null;
  return formatMoney(amt, cur);
}

function findStringAmount(
  src: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return v;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return String(v);
  }
  return null;
}

function formatMoney(amount: string, currency?: string | null): string {
  try {
    const n = Number(amount);
    if (!Number.isFinite(n)) return `${amount} ${currency ?? ""}`.trim();
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${amount} ${currency ?? ""}`.trim();
  }
}

function fmtAbs(iso: string): string {
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }) +
      " · " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    );
  } catch {
    return iso;
  }
}

function fmtRelative(iso: string): string {
  try {
    const d = new Date(iso).getTime();
    const now = Date.now();
    const diff = now - d;
    const m = Math.round(diff / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function shortTripId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}
