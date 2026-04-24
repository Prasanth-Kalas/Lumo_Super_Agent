"use client";

/**
 * AgentCard — the atomic unit of the marketplace grid.
 *
 * Renders one agent's logo / name / one-liner / category / connected
 * badge and (depending on context) a Connect / Manage / Open button.
 *
 * Kept dumb: all behavior lives in the parent. This just draws.
 */

import Link from "next/link";
import { BrandMark } from "./BrandMark";

export interface AgentCardProps {
  agent_id: string;
  display_name: string;
  one_liner: string;
  category?: string | null;
  logo_url?: string | null;
  connected: boolean;
  connecting?: boolean;
  pricing_note?: string | null;
  onConnect?: () => void;
  /** When true, renders as a Link to the detail page. Otherwise just a card. */
  linkToDetail?: boolean;
  /**
   * "lumo" (default) for native agents, "mcp" for Model Context
   * Protocol servers. Drives the small "via MCP" badge so users
   * can distinguish transactional Lumo agents from third-party
   * read-heavy integrations at a glance.
   */
  source?: "lumo" | "mcp";
}

export function AgentCard(props: AgentCardProps) {
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
                Connected
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
        {props.onConnect ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
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
              ? "Opening…"
              : props.connected
              ? "Manage"
              : "Connect"}
          </button>
        ) : null}
      </div>
    </div>
  );

  if (props.linkToDetail) {
    return (
      <Link
        href={`/marketplace/${props.agent_id}`}
        className="block focus:outline-none focus:ring-2 focus:ring-lumo-accent rounded-xl"
      >
        {body}
      </Link>
    );
  }
  return body;
}

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
        className="h-10 w-10 rounded-lg border border-lumo-hair bg-lumo-elevated object-cover"
      />
    );
  }
  return (
    <div className="h-10 w-10 rounded-lg border border-lumo-hair bg-lumo-elevated flex items-center justify-center text-lumo-fg-mid">
      <BrandMark size={18} />
    </div>
  );
}
