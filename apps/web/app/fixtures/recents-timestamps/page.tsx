"use client";

import LeftRail from "@/components/LeftRail";

export default function RecentsTimestampsFixture() {
  return (
    <main className="flex h-dvh bg-lumo-bg text-lumo-fg">
      <LeftRail
        currentSessionId="session_recent_2"
        recentsRefreshKey="fixture"
        onNewChat={() => {
          // Fixture-only no-op.
        }}
      />
      <section className="flex min-w-0 flex-1 items-center justify-center px-10">
        <div className="max-w-md text-center">
          <div className="text-[11px] uppercase tracking-[0.18em] text-lumo-fg-low">
            WEB-RECENTS-TIMESTAMP-PORT-1
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-lumo-fg">
            Recents timestamp fixture
          </h1>
          <p className="mt-2 text-sm leading-6 text-lumo-fg-mid">
            The capture script intercepts history responses so the left rail
            renders stable iOS-style relative timestamps.
          </p>
        </div>
      </section>
    </main>
  );
}
