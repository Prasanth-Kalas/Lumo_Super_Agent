"use client";

/**
 * Shared chart chrome — title row, fixture badge, empty state, frame.
 *
 * Every chart in the intelligence dashboard wraps its body in
 * <ChartFrame> so the section heading style stays in one place. The
 * fixture badge appears whenever the API returned `is_fixture: true`,
 * making it obvious to the operator that they're looking at demo data
 * during the SDK-1 rollout.
 */

import type { ReactNode } from "react";

interface FrameProps {
  title: string;
  subtitle?: string;
  isFixture?: boolean;
  legend?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

export function ChartFrame({
  title,
  subtitle,
  isFixture,
  legend,
  action,
  children,
}: FrameProps) {
  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h2 className="text-[14px] font-semibold tracking-tight flex items-center gap-2">
            {title}
            {isFixture ? <FixtureBadge /> : null}
          </h2>
          {subtitle ? (
            <p className="text-[12px] text-lumo-fg-mid">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {legend}
          {action}
        </div>
      </header>
      {children}
    </section>
  );
}

export function FixtureBadge() {
  return (
    <span
      title="Brain SDK-1 not yet emitting; rendering deterministic demo data."
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] uppercase tracking-[0.14em] border border-amber-500/30 bg-amber-500/10 text-amber-400"
    >
      demo data
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-lumo-hair bg-lumo-surface/40 p-6 text-center text-[12.5px] text-lumo-fg-low">
      {children}
    </div>
  );
}
