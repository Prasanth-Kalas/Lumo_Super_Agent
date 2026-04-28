"use client";

/**
 * TimeRangePicker — segmented control for 1h / 24h / 7d / 30d.
 *
 * The dashboard treats the time range as the primary filter; every
 * chart re-fetches when this changes. Stateless on purpose — owning
 * page holds the value so it can be reflected into the URL query
 * later without restructuring.
 */

import { TIME_RANGES, type TimeRange } from "@/lib/admin/intelligence-api";

interface Props {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
  disabled?: boolean;
}

export function TimeRangePicker({ value, onChange, disabled }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="inline-flex items-center rounded-md border border-lumo-hair bg-lumo-surface p-0.5"
    >
      {TIME_RANGES.map((r) => {
        const active = r.value === value;
        return (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(r.value)}
            className={
              "h-7 px-3 rounded-sm text-[12px] tracking-tight transition-colors " +
              (active
                ? "bg-lumo-elevated text-lumo-fg"
                : "text-lumo-fg-mid hover:text-lumo-fg")
            }
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
