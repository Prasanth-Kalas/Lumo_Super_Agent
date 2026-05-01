"use client";

import { useEffect, useMemo, useState } from "react";
import { CompoundLegDetailContent } from "./CompoundLegDetailContent";
import {
  coerceCompoundEvidence,
  hasCompoundLegMetadata,
  isCompoundTerminalStatus,
  mergeCompoundLegMetadata,
  normalizeCompoundTimestamp,
  type CompoundLegDetailStatus,
  type CompoundLegMetadata,
} from "@/lib/compound-leg-detail";

export type CompoundLegStripStatus = CompoundLegDetailStatus;

export interface CompoundLegStripLeg {
  leg_id: string;
  agent_id: string;
  agent_display_name: string;
  description: string;
  status: CompoundLegStripStatus;
  depends_on?: string[];
  timestamp?: string | null;
  provider_reference?: string | null;
  evidence?: Record<string, string> | null;
}

export interface CompoundLegStripPayload {
  kind: "assistant_compound_dispatch";
  compound_transaction_id: string;
  legs: CompoundLegStripLeg[];
}

export interface CompoundLegStripProps {
  payload: CompoundLegStripPayload;
  streamUrl?: string | null;
  expandedLegIds?: Record<string, boolean>;
  onToggleLeg?: (legId: string) => void;
}

export default function CompoundLegStrip({
  payload,
  streamUrl,
  expandedLegIds,
  onToggleLeg,
}: CompoundLegStripProps) {
  const initialStatuses = useMemo(
    () => Object.fromEntries(payload.legs.map((leg) => [leg.leg_id, leg.status])),
    [payload.legs],
  );
  const initialMetadata = useMemo(
    () =>
      Object.fromEntries(
        payload.legs.map((leg) => [
          leg.leg_id,
          {
            timestamp: leg.timestamp ?? null,
            provider_reference: leg.provider_reference ?? null,
            evidence: leg.evidence ?? null,
          } satisfies CompoundLegMetadata,
        ]),
      ),
    [payload.legs],
  );
  const [statuses, setStatuses] =
    useState<Record<string, CompoundLegStripStatus>>(initialStatuses);
  const [metadataByLeg, setMetadataByLeg] =
    useState<Record<string, CompoundLegMetadata>>(initialMetadata);
  const [localExpandedLegIds, setLocalExpandedLegIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setStatuses(initialStatuses);
  }, [initialStatuses]);
  useEffect(() => {
    setMetadataByLeg(initialMetadata);
  }, [initialMetadata]);

  const settled = payload.legs.every((leg) =>
    isCompoundTerminalStatus(statuses[leg.leg_id] ?? leg.status),
  );
  const expanded = expandedLegIds ?? localExpandedLegIds;
  const toggleLeg = onToggleLeg ?? ((legId: string) => {
    setLocalExpandedLegIds((prev) => ({ ...prev, [legId]: !prev[legId] }));
  });

  useEffect(() => {
    if (streamUrl === null) return;
    if (typeof EventSource === "undefined") return;
    if (settled) return;
    const url =
      streamUrl ??
      `/api/compound/transactions/${encodeURIComponent(payload.compound_transaction_id)}/stream`;
    const source = new EventSource(url);
    source.addEventListener("leg_status", (event) => {
      const frame = parseLegStatusFrame(event.data);
      if (!frame) return;
      setStatuses((prev) => ({
        ...prev,
        [frame.leg_id]: frame.status,
      }));
      setMetadataByLeg((prev) => ({
        ...prev,
        [frame.leg_id]: mergeCompoundLegMetadata(prev[frame.leg_id], frame.metadata),
      }));
    });
    source.addEventListener("error", () => {
      source.close();
    });
    return () => source.close();
  }, [payload.compound_transaction_id, settled, streamUrl]);

  return (
    <section
      aria-label="Compound trip progress"
      data-settled={settled ? "true" : "false"}
      className="w-full max-w-[620px] rounded-xl border border-lumo-hair bg-lumo-surface overflow-hidden animate-fade-up"
    >
      <div className="flex items-start justify-between gap-4 border-b border-lumo-hair px-4 py-3.5">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low font-medium">
            Multi-agent dispatch
          </div>
          <div className="mt-1 text-[14px] font-medium text-lumo-fg">
            Planning the trip across {payload.legs.length} agents
          </div>
        </div>
        <div
          className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
            settled
              ? "border-lumo-hair bg-lumo-inset text-lumo-fg-mid"
              : "border-lumo-edge bg-lumo-elevated text-lumo-fg"
          }`}
        >
          {settled ? "Settled" : "Live"}
        </div>
      </div>
      <div className="divide-y divide-lumo-hair">
        {payload.legs.map((leg) => {
          const status = statuses[leg.leg_id] ?? leg.status;
          const metadata = metadataByLeg[leg.leg_id] ?? {};
          const canExpand = hasCompoundLegMetadata(metadata);
          const isExpanded = canExpand && expanded[leg.leg_id] === true;
          const row = (
            <>
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-lumo-hair bg-lumo-inset text-[15px] text-lumo-fg">
                {agentGlyph(leg.agent_id)}
              </div>
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium text-lumo-fg truncate">
                  {leg.description}
                </div>
                <div className="mt-0.5 text-[11.5px] text-lumo-fg-low truncate">
                  {leg.agent_display_name}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${statusClass(
                    status,
                  )}`}
                >
                  <span
                    className={
                      status === "in_flight" || status === "rollback_pending"
                        ? "inline-block h-1.5 w-1.5 rounded-full bg-current mr-1.5 animate-pulse align-middle"
                        : "hidden"
                    }
                  />
                  {statusLabel(status)}
                </span>
                {canExpand ? (
                  <span
                    aria-hidden
                    className={`text-[18px] leading-none text-lumo-fg-low transition-transform duration-150 ${
                      isExpanded ? "rotate-90" : ""
                    }`}
                  >
                    ›
                  </span>
                ) : null}
              </div>
            </>
          );
          return (
            <div
              key={leg.leg_id}
              data-leg-id={leg.leg_id}
              data-status={status}
            >
              {canExpand ? (
                <button
                  type="button"
                  className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-lumo-elevated/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lumo-edge"
                  aria-expanded={isExpanded}
                  aria-controls={`compound-leg-detail-${leg.leg_id}`}
                  onClick={() => toggleLeg(leg.leg_id)}
                  data-testid={`compound-leg-strip-row-${leg.leg_id}`}
                >
                  {row}
                </button>
              ) : (
                <div
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3"
                  data-testid={`compound-leg-strip-row-${leg.leg_id}`}
                >
                  {row}
                </div>
              )}
              {isExpanded ? (
                <CompoundLegDetailContent
                  leg={leg}
                  status={status}
                  metadata={metadata}
                  settled={settled}
                  allLegs={payload.legs}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function parseLegStatusFrame(data: string): {
  leg_id: string;
  status: CompoundLegStripStatus;
  metadata: CompoundLegMetadata;
} | null {
  try {
    const frame = JSON.parse(data) as Record<string, unknown>;
    const legId = typeof frame.leg_id === "string" ? frame.leg_id : "";
    const status = typeof frame.status === "string" ? frame.status : "";
    if (!legId || !isCompoundLegStripStatus(status)) return null;
    return {
      leg_id: legId,
      status,
      metadata: {
        timestamp: normalizeCompoundTimestamp(frame.timestamp),
        provider_reference:
          typeof frame.provider_reference === "string" ? frame.provider_reference : null,
        evidence: coerceCompoundEvidence(frame.evidence),
      },
    };
  } catch {
    return null;
  }
}

function isCompoundLegStripStatus(value: string): value is CompoundLegStripStatus {
  return (
    value === "pending" ||
    value === "in_flight" ||
    value === "committed" ||
    value === "failed" ||
    value === "rollback_pending" ||
    value === "rolled_back" ||
    value === "rollback_failed" ||
    value === "manual_review"
  );
}

function agentGlyph(agentId: string): string {
  if (agentId.includes("flight")) return "✈";
  if (agentId.includes("hotel")) return "⌂";
  return "◆";
}

function statusLabel(status: CompoundLegStripStatus): string {
  return status.replace(/_/g, " ");
}

function statusClass(status: CompoundLegStripStatus): string {
  if (status === "committed") return "border-lumo-ok/40 bg-lumo-ok/10 text-lumo-ok";
  if (status === "failed" || status === "rollback_failed") {
    return "border-lumo-danger/40 bg-lumo-danger/10 text-lumo-danger";
  }
  if (status === "rolled_back" || status === "manual_review") {
    return "border-lumo-warn/40 bg-lumo-warn/10 text-lumo-warn";
  }
  if (status === "in_flight" || status === "rollback_pending") {
    return "border-lumo-edge bg-lumo-elevated text-lumo-fg";
  }
  return "border-lumo-hair bg-lumo-inset text-lumo-fg-mid";
}
