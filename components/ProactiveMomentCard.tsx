"use client";

/**
 * ProactiveMomentCard — surfaces one proactive moment from
 * Sprint 2's proactive-scan cron. Self-contained: takes one
 * ProactiveMoment, renders the urgency-accent edge, type badge,
 * title, body, and two CTAs (Act on / Dismiss).
 *
 * Wiring into the workspace happens in a follow-up commit once
 * the cron and the GET endpoint are live; for now this is a pure
 * presentational component with no data fetching.
 */

import {
  formatMomentExpiry,
  formatMomentRelative,
  momentTypeIcon,
  urgencyAccent,
  type ProactiveMoment,
} from "@/lib/proactive-moment-card-helpers";

interface Props {
  moment: ProactiveMoment;
  onAct?: (id: string) => void | Promise<void>;
  onDismiss?: (id: string) => void | Promise<void>;
  busy?: boolean;
}

export function ProactiveMomentCard({
  moment,
  onAct,
  onDismiss,
  busy = false,
}: Props) {
  const accent = urgencyAccent(moment.urgency);
  const typeBadge = momentTypeIcon(moment.moment_type);
  const ago = formatMomentRelative(moment.created_at);
  const expiry = formatMomentExpiry(moment.valid_until);

  return (
    <article
      className="relative overflow-hidden rounded-xl border border-lumo-hair bg-lumo-surface p-4 pl-5"
      data-urgency={moment.urgency}
      data-moment-type={moment.moment_type}
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ backgroundColor: `var(${accent.varName})` }}
      />

      <header className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-lumo-hair text-lumo-fg-mid"
            aria-label={typeBadge.label}
          >
            <span aria-hidden>{typeBadge.glyph}</span>
            {typeBadge.label}
          </span>
          <span
            className="text-[10.5px] uppercase tracking-wide rounded px-1.5 py-0.5"
            style={{
              color: `var(${accent.varName})`,
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: `color-mix(in srgb, var(${accent.varName}) 30%, transparent)`,
              backgroundColor: `color-mix(in srgb, var(${accent.varName}) 10%, transparent)`,
            }}
          >
            {accent.label}
          </span>
        </div>
        {ago ? (
          <span className="text-[11px] text-lumo-fg-low whitespace-nowrap">{ago}</span>
        ) : null}
      </header>

      <h3 className="text-[15px] font-semibold text-lumo-fg leading-tight mb-1">
        {moment.title}
      </h3>
      <p className="text-[13px] text-lumo-fg-mid leading-relaxed">{moment.body}</p>

      {expiry ? (
        <p className="mt-2 text-[11px] text-lumo-fg-low">{expiry}</p>
      ) : null}

      {(onAct || onDismiss) && (
        <footer className="flex items-center gap-2 mt-3">
          {onAct ? (
            <button
              type="button"
              onClick={() => void onAct(moment.id)}
              disabled={busy}
              className="h-7 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12px] font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
            >
              {busy ? "Working…" : "Act on this"}
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              onClick={() => void onDismiss(moment.id)}
              disabled={busy}
              className="h-7 px-3 rounded-md border border-lumo-hair text-[12px] text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge disabled:opacity-60 transition-colors"
            >
              Dismiss
            </button>
          ) : null}
        </footer>
      )}
    </article>
  );
}
