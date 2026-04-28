"use client";

/**
 * AuditLogPreview — read-only timeline of consent_audit_log entries
 * for the current user.
 *
 * ADR-012 §2.3 enumerates the action types. We render them as a
 * human-readable timeline so the user (and, on demand, an auditor
 * sitting next to the user) can see the full lifecycle of consent,
 * use, and deletion. The user CAN'T mutate this list — the table
 * is append-only at the DB level. This component just paints what
 * it gets back from /api/voice/audit (which Codex VOICE-1 wires up).
 *
 * Privacy choice: voice_id is never rendered. We show provider name
 * and event type, never the encrypted ID itself, even though the user
 * is "their own" — leaking the cloak server-side is a separate ADR
 * concern and the principle is "client never sees voice_id" (§2.8).
 */

import { useMemo } from "react";

export type AuditAction =
  | "consent_granted"
  | "consent_revoked"
  | "voice_clone_created"
  | "voice_clone_used"
  | "voice_clone_use_disclosed"
  | "voice_clone_accessed"
  | "voice_clone_deleted"
  | "voice_clone_deletion_failed"
  | "voice_sample_purged"
  | "wake_word_enabled"
  | "wake_word_disabled"
  | "interrupted_listening";

export interface AuditEntry {
  id: string;
  action: AuditAction;
  timestamp: string; // ISO 8601
  surface?: string | null;
  provider?: string | null;
  createdBy: "user" | "system" | "admin" | "service";
}

export interface AuditLogPreviewProps {
  entries: AuditEntry[] | null;
  /** Set when the entries list is being loaded. */
  loading?: boolean;
  /** Set when an error occurred fetching the audit log. */
  error?: string | null;
  /** Optional max entries to render. Defaults to 25. */
  limit?: number;
  /** Optional override for the empty-state copy. */
  emptyState?: string;
}

const ACTION_COPY: Record<
  AuditAction,
  { label: string; tone: "ok" | "warn" | "info" | "neutral" | "error" }
> = {
  consent_granted: { label: "Consent granted", tone: "ok" },
  consent_revoked: { label: "Consent revoked", tone: "warn" },
  voice_clone_created: { label: "Voice clone created", tone: "ok" },
  voice_clone_used: { label: "Cloned voice used", tone: "info" },
  voice_clone_use_disclosed: { label: "Use disclosed to you", tone: "info" },
  voice_clone_accessed: { label: "Voice profile accessed", tone: "warn" },
  voice_clone_deleted: { label: "Voice clone deleted", tone: "ok" },
  voice_clone_deletion_failed: {
    label: "Deletion failed (engineer notified)",
    tone: "error",
  },
  voice_sample_purged: { label: "Raw samples purged", tone: "neutral" },
  wake_word_enabled: { label: "Wake word turned on", tone: "ok" },
  wake_word_disabled: { label: "Wake word turned off", tone: "neutral" },
  interrupted_listening: { label: "Listening stopped", tone: "neutral" },
};

const TONE_DOT: Record<"ok" | "warn" | "info" | "neutral" | "error", string> = {
  ok: "bg-lumo-ok",
  warn: "bg-lumo-warn",
  info: "bg-lumo-accent",
  neutral: "bg-lumo-fg-low",
  error: "bg-red-500",
};

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const ms = Math.max(0, now - then);
  const s = Math.floor(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function AuditLogPreview(props: AuditLogPreviewProps) {
  const {
    entries,
    loading = false,
    error = null,
    limit = 25,
    emptyState = "No activity yet. As Lumo uses your voice, entries will appear here.",
  } = props;

  const visible = useMemo(() => {
    if (!entries) return [];
    return entries.slice(0, limit);
  }, [entries, limit]);

  return (
    <section
      aria-labelledby="audit-log-title"
      className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2
            id="audit-log-title"
            className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
          >
            Voice activity log
          </h2>
          <p className="mt-0.5 text-[12.5px] text-lumo-fg-mid">
            Append-only. Read-only. Mirrors what Lumo stores about your
            consent and voice usage.
          </p>
        </div>
        {entries && entries.length > limit ? (
          <span className="text-[11.5px] text-lumo-fg-low">
            Showing {limit} of {entries.length}
          </span>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500"
        >
          Couldn&apos;t load audit log: {error}
        </div>
      ) : null}

      {loading ? (
        <ul className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <li
              key={i}
              className="h-10 rounded-md border border-lumo-hair bg-lumo-bg/40 animate-pulse"
            />
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-lumo-hair bg-lumo-bg/40 px-3 py-6 text-center text-[12.5px] text-lumo-fg-mid">
          {emptyState}
        </div>
      ) : (
        <ol className="space-y-1.5" role="list">
          {visible.map((entry) => {
            const copy = ACTION_COPY[entry.action] ?? {
              label: entry.action,
              tone: "neutral" as const,
            };
            return (
              <li
                key={entry.id}
                className="flex items-center gap-3 rounded-md border border-lumo-hair bg-lumo-bg/40 px-3 py-2"
              >
                <span
                  aria-hidden="true"
                  className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${TONE_DOT[copy.tone]}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12.5px] text-lumo-fg-high font-medium">
                      {copy.label}
                    </span>
                    {entry.surface ? (
                      <span className="text-[11px] text-lumo-fg-low font-mono">
                        on {entry.surface}
                      </span>
                    ) : null}
                    {entry.provider ? (
                      <span className="text-[11px] text-lumo-fg-low">
                        via {entry.provider}
                      </span>
                    ) : null}
                  </div>
                </div>
                <time
                  dateTime={entry.timestamp}
                  className="text-[11.5px] text-lumo-fg-low whitespace-nowrap"
                  title={new Date(entry.timestamp).toLocaleString()}
                >
                  {formatRelative(entry.timestamp)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export default AuditLogPreview;
