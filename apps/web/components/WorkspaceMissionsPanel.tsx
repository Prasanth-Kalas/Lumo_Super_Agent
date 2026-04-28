"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MissionCard } from "@/components/MissionCard";
import {
  missionControlCounts,
  missionControlSummary,
  missionMatchesControlFilter,
  type MissionCardData,
  type MissionControlFilter,
} from "@/lib/mission-card-helpers";

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
  const [filter, setFilter] = useState<MissionControlFilter>("all");
  const counts = useMemo(() => missionControlCounts(missions), [missions]);
  const summary = useMemo(() => missionControlSummary(missions), [missions]);
  const visibleMissions = useMemo(
    () => missions.filter((mission) => missionMatchesControlFilter(mission, filter)),
    [filter, missions],
  );

  return (
    <section className="missions" aria-label="Active missions">
      <div className="missions__header">
        <div>
          <p className="missions__eyebrow">Missions</p>
          <h3 className="missions__title">Mission Control</h3>
          <p className="missions__summary">{summary}</p>
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

      {missions.length > 0 ? (
        <>
          <div className="missions__stats" aria-label="Mission status summary">
            <MissionStat label="Needs you" value={counts.needs_attention} />
            <MissionStat label="Active" value={counts.active} />
            <MissionStat label="Done" value={counts.done} />
          </div>
          <div className="missions__filters" aria-label="Mission filters">
            {(["all", "needs_attention", "active", "done"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={filter === f ? "is-active" : ""}
              >
                {filterLabel(f)}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="missions__stack">
        {loading && missions.length === 0 ? (
          <p className="missions__empty">Checking active missions...</p>
        ) : missions.length === 0 ? (
          <p className="missions__empty">
            No active missions. Type a multi-step request like &quot;plan my Vegas
            trip&quot; to start one.
          </p>
        ) : visibleMissions.length === 0 ? (
          <p className="missions__empty">No missions in this view.</p>
        ) : (
          visibleMissions.map((mission) => (
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
        .missions__summary {
          margin: 4px 0 0 0;
          color: var(--lumo-muted);
          font-size: 12.5px;
          line-height: 1.4;
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
        .missions__stats {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 10px;
        }
        .missions__stat {
          border: 1px solid var(--lumo-border);
          border-radius: 9px;
          padding: 8px 9px;
          background: var(--lumo-surface);
        }
        .missions__stat-value {
          color: var(--lumo-fg);
          font-size: 17px;
          font-weight: 650;
          line-height: 1;
        }
        .missions__stat-label {
          margin-top: 4px;
          color: var(--lumo-muted);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .missions__filters {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 10px;
        }
        .missions__filters button {
          height: 28px;
          border: 1px solid var(--lumo-border);
          background: transparent;
          color: var(--lumo-muted);
          border-radius: 8px;
          padding: 0 9px;
          font-size: 12px;
          cursor: pointer;
        }
        .missions__filters button:hover {
          color: var(--lumo-fg);
          border-color: var(--lumo-edge);
        }
        .missions__filters button.is-active {
          background: var(--lumo-fg);
          border-color: var(--lumo-fg);
          color: var(--lumo-bg);
        }
      `}</style>
    </section>
  );
}

function MissionStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="missions__stat">
      <div className="missions__stat-value">{value}</div>
      <div className="missions__stat-label">{label}</div>
    </div>
  );
}

function filterLabel(filter: MissionControlFilter): string {
  switch (filter) {
    case "needs_attention":
      return "Needs you";
    case "active":
      return "Active";
    case "done":
      return "Done";
    default:
      return "All";
  }
}
