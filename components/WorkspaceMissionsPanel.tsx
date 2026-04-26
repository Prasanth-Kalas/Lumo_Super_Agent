"use client";

import { useCallback, useEffect, useState } from "react";
import { MissionCard } from "@/components/MissionCard";
import type { MissionCardData } from "@/lib/mission-card-helpers";

interface MissionsEnvelope {
  missions?: MissionCardData[];
}

interface WorkspaceMissionsPanelProps {
  pollMs?: number;
}

interface WorkspaceMissionsPanelViewProps {
  missions: MissionCardData[];
  loading?: boolean;
  error?: string | null;
  busyId?: string | null;
  onRefresh?: () => void | Promise<void>;
  onCancel?: (id: string) => void | Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;

export function WorkspaceMissionsPanel({
  pollMs = DEFAULT_POLL_MS,
}: WorkspaceMissionsPanelProps) {
  const [missions, setMissions] = useState<MissionCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const r = await fetch("/api/workspace/missions?limit=5", {
        cache: "no-store",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`workspace/missions ${r.status}`);
      const body = (await r.json()) as MissionsEnvelope;
      setMissions(Array.isArray(body.missions) ? body.missions : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!Number.isFinite(pollMs) || pollMs <= 0) return;
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refresh]);

  const cancelMission = useCallback(
    async (id: string) => {
      try {
        setBusyId(id);
        setError(null);
        const r = await fetch(`/api/missions/${encodeURIComponent(id)}/cancel`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "workspace_cancel" }),
        });
        if (!r.ok) throw new Error(`mission cancel ${r.status}`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  return (
    <WorkspaceMissionsPanelView
      missions={missions}
      loading={loading}
      error={error}
      busyId={busyId}
      onRefresh={refresh}
      onCancel={cancelMission}
    />
  );
}

export function WorkspaceMissionsPanelView({
  missions,
  loading = false,
  error = null,
  busyId = null,
  onRefresh,
  onCancel,
}: WorkspaceMissionsPanelViewProps) {
  return (
    <section className="missions" aria-label="Active missions">
      <div className="missions__header">
        <div>
          <p className="missions__eyebrow">Missions</p>
          <h3 className="missions__title">Multi-app work in flight.</h3>
        </div>
        {onRefresh ? (
          <button
            className="missions__refresh"
            onClick={() => void onRefresh()}
            disabled={loading}
          >
            {loading ? "Checking" : "Refresh"}
          </button>
        ) : null}
      </div>

      {error ? <p className="missions__error">Couldn&apos;t load missions: {error}</p> : null}

      <div className="missions__stack">
        {loading && missions.length === 0 ? (
          <p className="missions__empty">Checking active missions...</p>
        ) : missions.length === 0 ? (
          <p className="missions__empty">
            No active missions. Type a multi-step request like &quot;plan my Vegas
            trip&quot; to start one.
          </p>
        ) : (
          missions.map((mission) => (
            <MissionCard
              key={mission.id}
              mission={mission}
              busy={busyId === mission.id}
              onCancel={onCancel}
            />
          ))
        )}
      </div>

      <style jsx>{`
        .missions {
          min-width: 0;
        }
        .missions__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .missions__eyebrow {
          margin: 0 0 3px 0;
          color: var(--lumo-fg-low);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .missions__title {
          margin: 0;
          color: var(--lumo-fg);
          font-size: 15px;
          font-weight: 600;
          line-height: 1.25;
        }
        .missions__refresh {
          border: 1px solid var(--lumo-border);
          background: transparent;
          color: var(--lumo-muted);
          border-radius: 8px;
          padding: 6px 9px;
          font-size: 12px;
          cursor: pointer;
          flex-shrink: 0;
        }
        .missions__refresh:hover {
          color: var(--lumo-fg);
          border-color: var(--lumo-edge);
        }
        .missions__refresh:disabled {
          cursor: wait;
          opacity: 0.6;
        }
        .missions__stack {
          display: grid;
          gap: 10px;
        }
        .missions__empty,
        .missions__error {
          margin: 0;
          color: var(--lumo-muted);
          font-size: 13px;
          line-height: 1.5;
        }
        .missions__error {
          color: var(--lumo-err);
          margin-bottom: 10px;
        }
      `}</style>
    </section>
  );
}
