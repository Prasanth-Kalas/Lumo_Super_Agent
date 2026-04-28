"use client";

import type { BrainCapability } from "@/lib/brain-capabilities";
import {
  brainCapabilityCounts,
  brainCapabilitySummary,
} from "@/lib/brain-capabilities";
import { ChartFrame } from "./ChartChrome";

interface Props {
  capabilities: BrainCapability[];
  isFixture?: boolean;
}

export function BrainCapabilityPanel({ capabilities, isFixture }: Props) {
  const counts = brainCapabilityCounts(capabilities);
  return (
    <ChartFrame
      title="Phase 3 readiness"
      subtitle={brainCapabilitySummary(capabilities)}
      isFixture={isFixture}
      legend={
        <div className="hidden sm:flex items-center gap-2 text-[11px] text-lumo-fg-low num">
          <span>{counts.ready} ready</span>
          <span>·</span>
          <span>{counts.watch} watch</span>
          <span>·</span>
          <span>{counts.pending} pending</span>
        </div>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
        {capabilities.map((capability) => (
          <CapabilityRow key={capability.id} capability={capability} />
        ))}
      </div>
    </ChartFrame>
  );
}

function CapabilityRow({ capability }: { capability: BrainCapability }) {
  const tone = statusTone(capability.status);
  return (
    <article className="rounded-lg border border-lumo-hair bg-lumo-bg/45 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-lumo-fg">
            {capability.title}
          </h3>
          <p className="mt-1 text-[11.5px] leading-5 text-lumo-fg-mid">
            {capability.description}
          </p>
        </div>
        <span
          className={
            "shrink-0 rounded-full border px-2 py-0.5 text-[9.5px] uppercase tracking-[0.13em] " +
            tone
          }
        >
          {capability.statusLabel}
        </span>
      </div>
      <div className="mt-3 border-t border-lumo-hair pt-2">
        <div className="text-[11px] text-lumo-fg-low">Next</div>
        <div className="mt-0.5 text-[12px] text-lumo-fg-mid">
          {capability.nextStep}
        </div>
        {capability.matchedEndpoints.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {capability.matchedEndpoints.slice(0, 3).map((endpoint) => (
              <span
                key={endpoint}
                className="rounded-full border border-lumo-hair bg-lumo-elevated px-2 py-0.5 text-[10.5px] text-lumo-fg-low num"
              >
                {endpoint}
              </span>
            ))}
            {capability.matchedEndpoints.length > 3 ? (
              <span className="rounded-full border border-lumo-hair bg-lumo-elevated px-2 py-0.5 text-[10.5px] text-lumo-fg-low num">
                +{capability.matchedEndpoints.length - 3}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function statusTone(status: BrainCapability["status"]): string {
  switch (status) {
    case "ready":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-400";
    case "watch":
      return "border-amber-500/25 bg-amber-500/10 text-amber-400";
    case "pending":
      return "border-lumo-hair bg-lumo-elevated text-lumo-fg-low";
  }
}
