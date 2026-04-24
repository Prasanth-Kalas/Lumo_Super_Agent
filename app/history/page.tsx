"use client";

/**
 * /history — the user's past conversations and orders.
 *
 * Product framing: the chat thread in / is "what you're doing right
 * now". /history is "what you've done". Two columns:
 *
 *   Left:  sessions — every conversation the user has had, newest
 *          first, with a short preview and the trip count.
 *   Right: trips — every trip the user has booked, attempted, or
 *          cancelled, with status, total, and per-leg breakdown.
 *
 * Data source: GET /api/history, which reads the `trips` and
 * `events` tables populated by the SSE route. No new persistence
 * surface.
 *
 * Voice users benefit from this too — they may have booked a flight
 * while driving and want to verify the confirmation when they get
 * home. The page is quiet, high-contrast, and can be the first
 * thing a user opens on their phone after a drive.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
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

export default function HistoryPage() {
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/history");
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

  const activeTrip = data?.trips.find((t) => t.trip_id === selectedTrip) ?? null;

  return (
    <div className="min-h-screen bg-lumo-bg text-lumo-fg">
      <header className="border-b border-lumo-hair sticky top-0 z-10 bg-lumo-bg/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-5 h-14 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-lumo-fg">
            <BrandMark size={20} />
            <span className="text-[15px] font-medium">Lumo</span>
          </Link>
          <span className="text-lumo-fg-low text-[13px]">/ History</span>
          <div className="ml-auto flex items-center gap-3">
            <Link
              href="/"
              className="text-[13px] text-lumo-fg-low hover:text-lumo-fg transition"
            >
              Back to chat
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {loading ? (
        <Center>Loading history…</Center>
      ) : err ? (
        <Center>
          Couldn&apos;t load history: {err}. If your admin hasn&apos;t
          configured persistence yet, history won&apos;t be available.
        </Center>
      ) : !data || (data.sessions.length === 0 && data.trips.length === 0) ? (
        <Center>
          <div className="max-w-md text-center space-y-2">
            <div className="text-[15px] text-lumo-fg">No history yet.</div>
            <div className="text-[13px] text-lumo-fg-low">
              Once you book something with Lumo, or your admin
              enables persistence on the server, your past
              conversations and orders will appear here.
            </div>
          </div>
        </Center>
      ) : (
        <div className="mx-auto max-w-6xl px-5 py-6 grid grid-cols-1 md:grid-cols-[minmax(260px,320px)_1fr] gap-6">
          {/* ── Sessions column ─────────────────────────────────── */}
          <div>
            <h2 className="text-[11px] uppercase tracking-wider text-lumo-fg-low mb-2">
              Conversations
            </h2>
            <ul className="space-y-1">
              {data.sessions.map((s) => (
                <li key={s.session_id}>
                  <div className="rounded-lg border border-lumo-hair bg-lumo-surface px-3 py-2.5">
                    <div className="text-[13px] text-lumo-fg line-clamp-2">
                      {s.preview ?? <em className="text-lumo-fg-low">(empty session)</em>}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-lumo-fg-low">
                      <span>{fmtRelative(s.last_activity_at)}</span>
                      <span aria-hidden>·</span>
                      <span>
                        {s.user_message_count} message
                        {s.user_message_count === 1 ? "" : "s"}
                      </span>
                      {s.trip_ids.length > 0 ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-lumo-accent">
                            {s.trip_ids.length} trip
                            {s.trip_ids.length === 1 ? "" : "s"}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {s.trip_ids.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {s.trip_ids.map((tid) => (
                          <button
                            key={tid}
                            type="button"
                            onClick={() => setSelectedTrip(tid)}
                            className={
                              "rounded-full border px-2 py-0.5 text-[11px] transition " +
                              (selectedTrip === tid
                                ? "border-lumo-accent text-lumo-accent"
                                : "border-lumo-border text-lumo-fg-low hover:text-lumo-fg")
                            }
                          >
                            {shortTripId(tid)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
              {data.sessions.length === 0 ? (
                <li className="text-[13px] text-lumo-fg-low px-3 py-2">
                  No past conversations.
                </li>
              ) : null}
            </ul>
          </div>

          {/* ── Trips / detail column ───────────────────────────── */}
          <div>
            <h2 className="text-[11px] uppercase tracking-wider text-lumo-fg-low mb-2">
              {activeTrip ? "Trip detail" : "All trips"}
            </h2>

            {activeTrip ? (
              <TripDetail trip={activeTrip} onBack={() => setSelectedTrip(null)} />
            ) : (
              <ul className="space-y-2">
                {data.trips.length === 0 ? (
                  <li className="text-[13px] text-lumo-fg-low px-3 py-2">
                    No bookings yet.
                  </li>
                ) : (
                  data.trips.map((t) => (
                    <li key={t.trip_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedTrip(t.trip_id)}
                        className="w-full text-left rounded-xl border border-lumo-hair bg-lumo-surface px-4 py-3 hover:border-lumo-edge transition"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[14px] text-lumo-fg truncate">
                              {t.payload.trip_title ?? "Trip"}
                            </div>
                            <div className="mt-0.5 text-[12px] text-lumo-fg-low">
                              {fmtAbs(t.created_at)}
                              {t.payload.legs?.length
                                ? ` · ${t.payload.legs.length} leg${
                                    t.payload.legs.length === 1 ? "" : "s"
                                  }`
                                : ""}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <StatusPill status={t.status} />
                            {t.payload.total_amount ? (
                              <div className="text-[13px] text-lumo-fg tabular-nums">
                                {formatMoney(
                                  t.payload.total_amount,
                                  t.payload.currency,
                                )}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

function TripDetail({
  trip,
  onBack,
}: {
  trip: TripRow;
  onBack: () => void;
}) {
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
      if (!res.ok && res.status !== 202) throw new Error(j.message ?? `${res.status}`);
      setCancelState("ok");
      setCancelMsg(j.message ?? j.action ?? "Cancel recorded.");
    } catch (e) {
      setCancelState("err");
      setCancelMsg(e instanceof Error ? e.message : "unknown");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-[12px] text-lumo-fg-low hover:text-lumo-fg"
        >
          ← Back to all trips
        </button>
      </div>

      <div className="rounded-xl border border-lumo-hair bg-lumo-surface p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[16px] text-lumo-fg">
              {trip.payload.trip_title ?? "Trip"}
            </div>
            <div className="mt-0.5 text-[12px] text-lumo-fg-low">
              {fmtAbs(trip.created_at)} · trip {shortTripId(trip.trip_id)}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <StatusPill status={trip.status} />
            {trip.payload.total_amount ? (
              <div className="text-[15px] text-lumo-fg tabular-nums">
                {formatMoney(trip.payload.total_amount, trip.payload.currency)}
              </div>
            ) : null}
          </div>
        </div>

        {trip.payload.legs?.length ? (
          <ul className="divide-y divide-lumo-hair rounded-lg border border-lumo-hair">
            {trip.payload.legs.map((leg) => (
              <li
                key={leg.order}
                className="flex items-start justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-[13px] text-lumo-fg">
                    Leg {leg.order} · {legFriendly(leg.agent_id)}
                  </div>
                  <div className="text-[12px] text-lumo-fg-low truncate">
                    {leg.tool_name ?? ""}
                  </div>
                </div>
                {legAmount(leg) ? (
                  <div className="text-[13px] text-lumo-fg tabular-nums shrink-0">
                    {legAmount(leg)}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {canCancel ? (
          <div className="pt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={doCancel}
              disabled={cancelState === "requesting"}
              className="rounded-full border border-lumo-border px-3 py-1.5 text-[12px] text-lumo-fg hover:bg-lumo-bg-subtle disabled:opacity-50"
            >
              {cancelState === "requesting" ? "Cancelling…" : "Cancel / refund"}
            </button>
            {cancelMsg ? (
              <span
                className={
                  "text-[12px] " +
                  (cancelState === "err" ? "text-red-400" : "text-lumo-fg-low")
                }
              >
                {cancelMsg}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const [label, tone] = statusTone(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] uppercase tracking-wider ${tone}`}
    >
      {label}
    </span>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-5 py-24 flex items-center justify-center text-lumo-fg-low text-[14px]">
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function statusTone(status: string): [string, string] {
  switch (status) {
    case "committed":
      return ["booked", "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"];
    case "dispatching":
      return ["booking…", "bg-amber-500/10 text-amber-400 border border-amber-500/20"];
    case "draft":
      return ["draft", "bg-lumo-bg-subtle text-lumo-fg-low border border-lumo-border"];
    case "confirmed":
      return ["confirmed", "bg-lumo-accent/10 text-lumo-accent border border-lumo-accent/20"];
    case "rolled_back":
      return ["refunded", "bg-lumo-bg-subtle text-lumo-fg-low border border-lumo-border"];
    case "rollback_failed":
      return ["needs attention", "bg-red-500/10 text-red-400 border border-red-500/20"];
    default:
      return [status, "bg-lumo-bg-subtle text-lumo-fg-low border border-lumo-border"];
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

function legAmount(leg: {
  summary?: { payload?: unknown };
}): string | null {
  if (!leg.summary || typeof leg.summary !== "object") return null;
  const p = (leg.summary.payload ?? {}) as Record<string, unknown>;
  const amt =
    findStringAmount(p, ["total_amount", "subtotal", "total", "price", "amount"]) ??
    null;
  const cur =
    typeof p["currency"] === "string" && /^[A-Z]{3}$/.test(p["currency"] as string)
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
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
