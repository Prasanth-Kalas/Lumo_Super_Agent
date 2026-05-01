"use client";

import { useEffect, useState } from "react";
import {
  compoundLegDetailModel,
  elapsedLabel,
  type CompoundLegDetailLeg,
  type CompoundLegDetailStatus,
  type CompoundLegMetadata,
} from "@/lib/compound-leg-detail";

export interface CompoundLegDetailContentProps {
  leg: CompoundLegDetailLeg;
  status: CompoundLegDetailStatus;
  metadata: CompoundLegMetadata;
  settled: boolean;
  allLegs: CompoundLegDetailLeg[];
}

export function CompoundLegDetailContent({
  leg,
  status,
  metadata,
  settled,
  allLegs,
}: CompoundLegDetailContentProps) {
  const model = compoundLegDetailModel({
    leg,
    status,
    metadata,
    settled,
    allLegs,
  });

  return (
    <div
      id={`compound-leg-detail-${leg.leg_id}`}
      className="border-t border-lumo-hair bg-lumo-elevated/40 px-4 py-3"
      data-testid={`compound-leg-strip-row-${leg.leg_id}-detail`}
    >
      <div className="space-y-2">
        {model.lines.map((line) => (
          <div key={`${line.label}:${line.text}`} className="space-y-0.5">
            <div className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-lumo-fg-low">
              {line.label}
            </div>
            <div
              className={`text-[13px] leading-relaxed ${toneClass(line.tone)} ${
                line.mono ? "font-mono" : ""
              }`}
            >
              {line.text}
            </div>
          </div>
        ))}
        {model.elapsed_started_at ? (
          <ElapsedTicker startedAt={model.elapsed_started_at} />
        ) : null}
      </div>
    </div>
  );
}

function ElapsedTicker({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      className="font-mono text-[12px] leading-relaxed text-lumo-fg-low"
      data-testid="compound-leg-detail.elapsed"
    >
      {elapsedLabel(startedAt, now)}
    </div>
  );
}

function toneClass(tone: "primary" | "secondary" | "success" | "warning" | "error"): string {
  if (tone === "primary") return "text-lumo-fg";
  if (tone === "success") return "text-lumo-ok";
  if (tone === "warning") return "text-lumo-warn";
  if (tone === "error") return "text-lumo-danger";
  return "text-lumo-fg-mid";
}
