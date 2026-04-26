"use client";

/**
 * AgentCard — the atomic unit of the marketplace grid.
 *
 * Renders one agent's logo / name / one-liner / category / connected
 * badge and (depending on context) a Connect / Manage / Open button.
 *
 * Kept dumb: all behavior lives in the parent. This just draws.
 */

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { logPreferenceEvent } from "@/lib/preference-events-client";

export interface AgentCardProps {
  agent_id: string;
  display_name: string;
  one_liner: string;
  category?: string | null;
  logo_url?: string | null;
  connected: boolean;
  connecting?: boolean;
  status_label?: string;
  action_label?: string;
  pricing_note?: string | null;
  onConnect?: () => void;
  /** When true, renders as a Link to the detail page. Otherwise just a card. */
  linkToDetail?: boolean;
  /**
   * "lumo" (default) for native agents, "mcp" for Model Context
   * Protocol servers, "coming_soon" for placeholder tiles whose
   * real connector is being built or in App Review.
   */
  source?: "lumo" | "mcp" | "coming_soon";
  /** When source==='coming_soon', the pill label rendered in place of Connect. */
  coming_soon_label?: string;
  /** When source==='coming_soon', tooltip-shown rationale (eta + why). */
  coming_soon_rationale?: string;
  risk_badge?: {
    level: "low" | "medium" | "high" | "review_required";
    score: number;
    reasons: string[];
    mitigations?: string[];
    source: "ml" | "fallback";
  } | null;
}

export function AgentCard(props: AgentCardProps) {
  const preferenceContext = useMemo(
    () => ({
      display_name: props.display_name,
      category: props.category ?? null,
      connected: props.connected,
      source: props.source ?? "lumo",
      risk_level: props.risk_badge?.level ?? null,
    }),
    [
      props.category,
      props.connected,
      props.display_name,
      props.risk_badge?.level,
      props.source,
    ],
  );

  useEffect(() => {
    const started = Date.now();
    logPreferenceEvent({
      surface: "marketplace_tile",
      target_type: "agent",
      target_id: props.agent_id,
      event_type: "impression",
      context: preferenceContext,
    });
    return () => {
      logPreferenceEvent({
        surface: "marketplace_tile",
        target_type: "agent",
        target_id: props.agent_id,
        event_type: "dwell",
        dwell_ms: Date.now() - started,
        context: preferenceContext,
      });
    };
  }, [
    props.agent_id,
    preferenceContext,
  ]);

  const body = (
    <div className="group relative rounded-xl border border-lumo-hair bg-lumo-surface p-4 hover:border-lumo-edge transition-colors">
      <div className="flex items-start gap-3">
        <Logo logo_url={props.logo_url} alt={props.display_name} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[14.5px] font-semibold text-lumo-fg truncate">
              {props.display_name}
            </div>
            {props.connected ? (
              <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-lumo-ok border border-lumo-ok/30 bg-lumo-ok/10 rounded px-1.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-lumo-ok" />
                {props.status_label ?? "Connected"}
              </span>
            ) : null}
            {props.source === "mcp" ? (
              <span
                className="inline-flex items-center text-[10px] uppercase tracking-[0.12em] text-lumo-fg-low border border-lumo-hair rounded px-1.5 py-0.5"
                title="Powered by Model Context Protocol"
              >
                via MCP
              </span>
            ) : null}
            {props.risk_badge ? <RiskBadge badge={props.risk_badge} /> : null}
          </div>
          {props.category ? (
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low mt-0.5">
              {props.category}
            </div>
          ) : null}
          <p className="text-[12.5px] text-lumo-fg-mid mt-1.5 leading-relaxed line-clamp-2">
            {props.one_liner}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-lumo-hair">
        <div className="text-[11px] text-lumo-fg-low">
          {props.pricing_note ?? ""}
        </div>
        {props.source === "coming_soon" ? (
          <span
            className="inline-flex items-center h-7 px-3 rounded-md text-[11px] uppercase tracking-[0.06em] font-medium border border-dashed border-lumo-hair text-lumo-fg-low cursor-default"
            title={props.coming_soon_rationale ?? ""}
          >
            {props.coming_soon_label ?? "Coming soon"}
          </span>
        ) : props.onConnect ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              logPreferenceEvent({
                surface: "marketplace_tile",
                target_type: "agent",
                target_id: props.agent_id,
                event_type: "click",
                context: {
                  ...preferenceContext,
                  action: props.connected ? "manage" : "connect",
                  connect_model: props.source ?? "lumo",
                },
              });
              props.onConnect?.();
            }}
            disabled={props.connecting}
            className={
              "h-7 px-3 rounded-md text-[12px] font-medium transition-colors " +
              (props.connected
                ? "border border-lumo-hair text-lumo-fg-mid hover:text-lumo-fg hover:border-lumo-edge"
                : "bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink") +
              (props.connecting ? " opacity-60 cursor-wait" : "")
            }
          >
            {props.connecting
              ? "Saving…"
              : props.action_label ??
                (props.connected ? "Manage" : "Connect")}
          </button>
        ) : null}
      </div>
    </div>
  );

  if (props.linkToDetail) {
    return (
      <Link
        href={`/marketplace/${props.agent_id}`}
        onClick={() => {
          logPreferenceEvent({
            surface: "marketplace_tile",
            target_type: "agent",
            target_id: props.agent_id,
            event_type: "click",
            context: { ...preferenceContext, action: "open_detail" },
          });
        }}
        className="block focus:outline-none focus:ring-2 focus:ring-lumo-accent rounded-xl"
      >
        {body}
      </Link>
    );
  }
  return body;
}

function RiskBadge({
  badge,
}: {
  badge: NonNullable<AgentCardProps["risk_badge"]>;
}) {
  const classes =
    badge.level === "low"
      ? "border-lumo-ok/30 bg-lumo-ok/10 text-lumo-ok"
      : badge.level === "medium"
        ? "border-lumo-warn/35 bg-lumo-warn/10 text-lumo-warn"
        : badge.level === "high"
          ? "border-lumo-err/35 bg-lumo-err/10 text-lumo-err"
          : "border-lumo-hair bg-lumo-bg text-lumo-fg-low";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] border ${classes}`}
      title={badge.reasons.join("; ")}
    >
      {badge.level === "review_required" ? "review" : `${badge.level} risk`}
    </span>
  );
}

/**
 * Logo for an agent card — partner-supplied bitmap when present,
 * otherwise a deterministic colored-initial tile so each agent
 * still has a distinct visual identity in the marketplace grid.
 *
 * The tile color is hashed off the display name so the same agent
 * always gets the same color across renders. Tailwind's JIT can't
 * see dynamic class names, so the four-color rotation is hardcoded
 * as full class strings rather than templated.
 */
function Logo({
  logo_url,
  alt,
}: {
  logo_url?: string | null;
  alt: string;
}) {
  if (logo_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={logo_url}
        alt={alt}
        className="h-10 w-10 rounded-lg border border-lumo-hair bg-lumo-bg object-cover shrink-0"
        loading="lazy"
        onError={(e) => {
          // If the URL 404s or CORS errors, hide the broken image —
          // the parent already renders the fallback tile underneath
          // for any agent whose logo_url is absent, but here we just
          // silently drop the broken pixel rather than show a glyph.
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  const initial = (alt || "?").trim().charAt(0).toUpperCase();
  const tones = [
    "bg-g-blue",
    "bg-g-red",
    "bg-g-yellow",
    "bg-g-green",
  ] as const;
  const tone = tones[hashName(alt) % tones.length] ?? "bg-g-blue";
  return (
    <div
      className={`h-10 w-10 rounded-lg border border-lumo-hair flex items-center justify-center text-[16px] font-semibold text-white shrink-0 ${tone}`}
      aria-hidden
    >
      {initial}
    </div>
  );
}

function hashName(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
