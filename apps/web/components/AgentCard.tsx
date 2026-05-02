"use client";

/**
 * AgentCard — the atomic unit of the marketplace grid.
 *
 * App Store-inspired layout:
 *   - 64×64 squircle logo with deterministic per-agent tint when no
 *     partner bitmap exists.
 *   - Title + category eyebrow + truncated one-liner stacked next to it.
 *   - Compact GET / OPEN / CONNECT pill on the right, App Store style.
 *   - "via MCP" / "Coming soon" / "Connected" badges pulled into
 *     subtle chip style; risk badges (low/medium/high) intentionally
 *     not rendered — the certified publish flow makes per-agent risk
 *     pills noisy at the catalog level.
 *
 * Kept dumb: all behavior lives in the parent. This just draws.
 */

import { useEffect, useMemo, useState } from "react";
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
  /**
   * Forward-compat: kept on the prop type so callers don't break,
   * but no longer rendered. The certified publish flow makes
   * per-agent risk pills noisy at the catalog level.
   */
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
    }),
    [
      props.category,
      props.connected,
      props.display_name,
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

  const cta = renderCta(props, preferenceContext);

  const body = (
    <div className="group relative h-full rounded-2xl border border-lumo-hair bg-lumo-surface p-5 transition-all hover:border-lumo-edge hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]">
      <div className="flex items-start gap-4">
        <Logo
          logo_url={props.logo_url}
          alt={props.display_name}
          agent_id={props.agent_id}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <div className="text-[15.5px] font-semibold text-lumo-fg truncate leading-tight">
              {props.display_name}
            </div>
          </div>
          {props.category ? (
            <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low">
              {props.category}
            </div>
          ) : null}
          <p className="mt-2 text-[12.5px] leading-relaxed text-lumo-fg-mid line-clamp-2">
            {props.one_liner}
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-lumo-fg-low">
          {props.connected ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-lumo-ok/30 bg-lumo-ok/10 px-2 py-0.5 text-lumo-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-lumo-ok" />
              {props.status_label ?? "Connected"}
            </span>
          ) : null}
          {props.source === "mcp" ? (
            <span
              className="inline-flex items-center rounded-full border border-lumo-hair px-2 py-0.5"
              title="Powered by Model Context Protocol"
            >
              MCP
            </span>
          ) : null}
          {props.pricing_note ? (
            <span className="normal-case tracking-normal text-[11px] text-lumo-fg-low">
              {props.pricing_note}
            </span>
          ) : null}
        </div>
        {cta}
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
        className="block h-full focus:outline-none focus:ring-2 focus:ring-lumo-accent rounded-2xl"
      >
        {body}
      </Link>
    );
  }
  return body;
}

function renderCta(
  props: AgentCardProps,
  preferenceContext: Record<string, unknown>,
) {
  if (props.source === "coming_soon") {
    return (
      <span
        className="inline-flex h-8 shrink-0 items-center rounded-full border border-dashed border-lumo-hair px-3 text-[11px] font-medium uppercase tracking-[0.06em] text-lumo-fg-low cursor-default"
        title={props.coming_soon_rationale ?? ""}
      >
        {props.coming_soon_label ?? "Coming soon"}
      </span>
    );
  }
  if (!props.onConnect) return null;
  const label = props.connecting
    ? "Saving…"
    : props.action_label ??
      (props.connected ? "Open" : "Get");
  return (
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
        "inline-flex h-8 shrink-0 items-center rounded-full px-4 text-[12.5px] font-semibold tracking-[0.02em] transition-colors " +
        (props.connected
          ? "bg-lumo-elevated text-lumo-accent hover:bg-lumo-elevated/80"
          : "bg-lumo-elevated text-lumo-fg hover:bg-lumo-fg hover:text-lumo-bg") +
        (props.connecting ? " opacity-60 cursor-wait" : "")
      }
    >
      {label.toUpperCase()}
    </button>
  );
}

/**
 * Logo for an agent card — partner-supplied bitmap when present,
 * otherwise a deterministic gradient squircle so each agent gets
 * a distinct visual identity. Tile color is hashed off agent_id so
 * the same agent always lands on the same color across renders.
 */
function Logo({
  logo_url,
  alt,
  agent_id,
}: {
  logo_url?: string | null;
  alt: string;
  agent_id: string;
}) {
  const [failed, setFailed] = useState(false);

  if (logo_url && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={logo_url}
        alt={alt}
        className="h-16 w-16 shrink-0 rounded-2xl border border-lumo-hair bg-lumo-bg object-cover"
        loading="lazy"
        onError={(e) => {
          e.currentTarget.style.display = "none";
          setFailed(true);
        }}
      />
    );
  }
  const initial = (alt || "?").trim().charAt(0).toUpperCase();
  const tones = [
    "from-sky-400 to-cyan-500",
    "from-violet-400 to-indigo-500",
    "from-amber-300 to-orange-500",
    "from-emerald-400 to-teal-500",
    "from-rose-400 to-pink-500",
    "from-blue-400 to-indigo-500",
  ] as const;
  const tone = tones[hashName(agent_id) % tones.length] ?? tones[0];
  return (
    <div
      className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${tone} text-[24px] font-semibold text-white shadow-[0_4px_12px_-4px_rgba(0,0,0,0.25)]`}
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
