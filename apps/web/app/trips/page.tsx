"use client";

/**
 * /trips — newest-first list of the user's trip history.
 *
 * Middleware gates this route, so logged-out visitors are bounced to
 * /login?next=/trips before this component ever renders.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  statusPillClass,
  summarize,
  type TripCardSummary,
} from "@/lib/web-screens-trips";
import type { TripHistoryRow } from "@/lib/history";

export default function TripsPage() {
  const [trips, setTrips] = useState<TripCardSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/trips", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { trips: TripHistoryRow[] };
        if (cancelled) return;
        setTrips(body.trips.map(summarize));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load trips");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Trips</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-6 py-12 space-y-10">
        <div className="space-y-3">
          <h1 className="font-display text-[44px] md:text-[64px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
            Your <span className="italic text-lumo-accent">trips.</span>
          </h1>
          <p className="text-[15px] text-lumo-fg-mid leading-[1.65] max-w-xl">
            Every trip Lumo has booked or attempted to book on your behalf.
            Tap one to see the legs and status.
          </p>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-2xl border border-lumo-err/30 bg-lumo-err/5 px-4 py-3 text-[13px] text-lumo-err"
          >
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-3">
            <div className="h-24 rounded-2xl border border-lumo-hair bg-lumo-surface animate-pulse" />
            <div className="h-24 rounded-2xl border border-lumo-hair bg-lumo-surface animate-pulse" />
          </div>
        ) : trips && trips.length > 0 ? (
          <ul className="space-y-3">
            {trips.map((t) => (
              <li key={t.trip_id}>
                <Link
                  href={`/trips/${t.trip_id}`}
                  className="block rounded-2xl border border-lumo-hair bg-lumo-surface px-5 py-4 hover:border-lumo-edge hover:shadow-card-lift transition-all"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[15px] font-medium text-lumo-fg truncate">
                        {t.title}
                      </div>
                      <div className="text-[12.5px] text-lumo-fg-low mt-1">
                        {new Date(t.created_at).toLocaleString()} · {t.leg_count} {t.leg_count === 1 ? "leg" : "legs"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {t.total ? (
                        <span className="text-[13.5px] font-medium text-lumo-fg">
                          {t.total}
                        </span>
                      ) : null}
                      <span
                        className={`text-[11px] px-2.5 py-0.5 rounded-full border ${statusPillClass(
                          t.status,
                        )}`}
                      >
                        {t.cancel_requested ? "Cancel pending" : t.status}
                      </span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-lumo-hair bg-lumo-bg/40 px-6 py-10 text-center">
            <p className="text-[14px] text-lumo-fg-mid leading-relaxed">
              No trips yet — Lumo will list your trip history here once it
              has booked something for you.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
