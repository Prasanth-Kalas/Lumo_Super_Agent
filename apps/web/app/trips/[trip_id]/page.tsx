"use client";

/**
 * /trips/[trip_id] — single trip detail with legs and Cancel control.
 *
 * Cancel POSTs to the existing /api/trip/[trip_id]/cancel endpoint.
 * Note the API path is singular (predates this surface) — only the
 * consumer page is plural.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  formatTripStatus,
  formatTotal,
  isCancellable,
  statusPillClass,
  type TripStatusLabel,
} from "@/lib/web-screens-trips";
import type { TripHistoryRow } from "@/lib/history";

export default function TripDetailPage() {
  const params = useParams<{ trip_id: string }>();
  const router = useRouter();
  const trip_id = params?.trip_id ?? "";
  const [trip, setTrip] = useState<TripHistoryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/trips/${trip_id}`, { cache: "no-store" });
      if (res.status === 404) {
        setError("Trip not found.");
        setTrip(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { trip: TripHistoryRow };
      setTrip(body.trip);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trip");
    } finally {
      setLoading(false);
    }
  }, [trip_id]);

  useEffect(() => {
    if (trip_id) void refresh();
  }, [trip_id, refresh]);

  const handleCancel = async () => {
    if (!trip) return;
    setCancelBusy(true);
    try {
      const res = await fetch(`/api/trip/${trip_id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user_cancel_from_trips_page" }),
      });
      if (!res.ok && res.status !== 202) {
        throw new Error(`HTTP ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setCancelBusy(false);
    }
  };

  const status: TripStatusLabel = trip ? formatTripStatus(trip.status) : "Draft";
  const total = trip ? formatTotal(trip.payload.total_amount, trip.payload.currency) : null;
  const legs = trip?.payload.legs ?? [];
  const cancellable =
    trip !== null && isCancellable(trip.status, trip.cancel_requested_at);

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <Link
              href="/trips"
              className="hidden sm:inline text-[13px] text-lumo-fg-mid hover:text-lumo-fg"
            >
              Trips
            </Link>
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg-low font-mono">
              {trip_id.slice(0, 8)}
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500"
          >
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="h-32 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
        ) : trip ? (
          <>
            <section
              aria-labelledby="trip-header-title"
              className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1
                    id="trip-header-title"
                    className="text-[22px] font-semibold tracking-[-0.02em] text-lumo-fg leading-tight"
                  >
                    {trip.payload.trip_title?.trim() || "Untitled trip"}
                  </h1>
                  <div className="text-[12px] text-lumo-fg-low mt-1">
                    Created {new Date(trip.created_at).toLocaleString()}
                  </div>
                </div>
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full border flex-shrink-0 ${statusPillClass(status)}`}
                >
                  {trip.cancel_requested_at ? "Cancel pending" : status}
                </span>
              </div>
              {total ? (
                <div className="text-[15px] font-medium text-lumo-fg">{total}</div>
              ) : null}
              {cancellable ? (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelBusy}
                  className="h-9 px-3.5 rounded-md border border-red-500/30 bg-red-500/5 text-[12.5px] text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {cancelBusy ? "Cancelling…" : "Cancel trip"}
                </button>
              ) : trip.cancel_requested_at ? (
                <p className="text-[12.5px] text-lumo-fg-mid">
                  Cancellation requested on{" "}
                  {new Date(trip.cancel_requested_at).toLocaleString()}.
                </p>
              ) : null}
            </section>

            <section
              aria-labelledby="trip-legs-title"
              className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3"
            >
              <h2
                id="trip-legs-title"
                className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
              >
                Legs
              </h2>
              {legs.length === 0 ? (
                <p className="text-[12.5px] text-lumo-fg-mid">
                  No legs were dispatched for this trip.
                </p>
              ) : (
                <ol className="space-y-2.5">
                  {legs.map((leg) => (
                    <li
                      key={`${leg.order}-${leg.agent_id}`}
                      className="rounded-md border border-lumo-hair bg-lumo-bg/40 p-3.5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="text-[13.5px] font-medium text-lumo-fg-high">
                          {leg.order + 1}. {leg.tool_name ?? leg.agent_id}
                        </div>
                        <div className="text-[11px] text-lumo-fg-low font-mono">
                          {leg.agent_id}
                        </div>
                      </div>
                      {leg.summary ? (
                        <div className="text-[12px] text-lumo-fg-mid mt-1">
                          {leg.summary.kind ?? "result"}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <button
              type="button"
              onClick={() => router.push("/trips")}
              className="text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg underline decoration-lumo-fg-low underline-offset-2"
            >
              ← Back to trips
            </button>
          </>
        ) : !error ? (
          <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-bg/40 px-5 py-8 text-center">
            <p className="text-[13.5px] text-lumo-fg-mid">Trip not found.</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
