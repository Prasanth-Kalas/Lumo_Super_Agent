"use client";

/**
 * /settings/voice — manage existing voice clone, revoke, and review the
 * audit log.
 *
 * Three sections:
 *   1. Status — VoiceStatusBadge + engine name + last-used time. Source
 *      of truth for "is my voice on, and which engine plays it."
 *   2. Actions — re-record (goes back through the full consent flow)
 *      and delete (one-click via RevocationDialog with 7-day SLA copy).
 *   3. Audit log — read-only timeline of consent_audit_log entries.
 *      Append-only at the DB level; this surface only displays.
 *
 * Empty state — when the user has no clone enrolled, the page is a
 * single CTA to /onboarding/voice. Settings is a useful place to come
 * back to when "should I try this?" comes up later, so we don't hide
 * the entry point.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  AuditLogPreview,
  type AuditEntry,
} from "@/components/voice/AuditLogPreview";
import { RevocationDialog } from "@/components/voice/RevocationDialog";
import {
  VoiceStatusBadge,
  type CloneStatus,
  type TTSEngine,
} from "@/components/voice/VoiceStatusBadge";

interface VoiceClonePayload {
  cloneStatus: CloneStatus;
  ttsEngine: TTSEngine;
  stockVoiceName: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  consentVersion: string | null;
}

export default function VoiceSettingsPage() {
  const [clone, setClone] = useState<VoiceClonePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [pendingDeletionNotice, setPendingDeletionNotice] = useState(false);

  // ----- Codex VOICE-1 stubs -----
  async function fetchVoiceClone(): Promise<VoiceClonePayload> {
    /* TODO: Codex VOICE-1 — GET /api/voice/clone. Returns the
     * voice_clones row (status, provider, last_used_at, consent
     * version). 404 ⇒ user has no clone yet. */
    return {
      cloneStatus: "not_enrolled",
      ttsEngine: "stock_voice",
      stockVoiceName: null,
      createdAt: null,
      lastUsedAt: null,
      consentVersion: null,
    };
  }

  async function fetchAuditLog(): Promise<AuditEntry[]> {
    /* TODO: Codex VOICE-1 — GET /api/voice/audit. Returns the user's
     * consent_audit_log rows, descending by timestamp. */
    return [];
  }

  async function revokeVoiceClone(_reason: string | null): Promise<void> {
    /* TODO: Codex VOICE-1 — POST /api/voice/clone/revoke. Triggers
     * the synchronous in-memory cache invalidation, writes
     * consent_revoked, schedules the provider/local delete via the
     * cron queue. */
  }
  // ----- end stubs -----

  const refresh = useCallback(async () => {
    setLoading(true);
    setAuditLoading(true);
    try {
      const [c, a] = await Promise.all([fetchVoiceClone(), fetchAuditLog()]);
      setClone(c);
      setAudit(a);
      setError(null);
      setAuditError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAuditError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRevoke = useCallback(
    async ({ reason }: { reason: string | null }) => {
      setRevoking(true);
      try {
        await revokeVoiceClone(reason);
        setPendingDeletionNotice(true);
        setRevokeOpen(false);
        // Optimistic UI — flip the badge to pending_deletion immediately
        // (matches the synchronous in-memory cache invalidation in
        // ADR-012 §6 step 1).
        setClone((c) =>
          c ? { ...c, cloneStatus: "pending_deletion" } : c,
        );
        // Refresh in the background so the audit log shows the new
        // consent_revoked row.
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Revocation failed");
      } finally {
        setRevoking(false);
      }
    },
    [refresh],
  );

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">
              Settings · Voice
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
            Your voice
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed max-w-2xl">
            Lumo can read drafts and summaries back to you in your own
            voice. Setup is opt-in, and you can delete your voice clone
            at any time. Every time the clone is used, an entry is
            written to your audit log below.
          </p>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500"
          >
            {error}
          </div>
        ) : null}

        {pendingDeletionNotice ? (
          <div className="rounded-md border border-lumo-warn/30 bg-lumo-warn/10 px-3 py-2.5 text-[12.5px] text-lumo-warn">
            Deletion in progress. Your voice will be permanently removed
            within 7 days. Lumo is no longer using it for playback.
          </div>
        ) : null}

        {/* Status card */}
        <section
          aria-labelledby="voice-status-title"
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2
              id="voice-status-title"
              className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
            >
              Status
            </h2>
            {clone?.consentVersion ? (
              <span className="text-[11px] text-lumo-fg-low font-mono">
                consent v{clone.consentVersion}
              </span>
            ) : null}
          </div>

          {loading || !clone ? (
            <div className="h-12 rounded-md border border-lumo-hair bg-lumo-bg/40 animate-pulse" />
          ) : (
            <>
              <VoiceStatusBadge
                cloneStatus={clone.cloneStatus}
                ttsEngine={clone.ttsEngine}
                stockVoiceName={clone.stockVoiceName}
                showEngineCaption
              />
              {clone.cloneStatus === "active" ? (
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 text-[12.5px]">
                  <div className="flex items-baseline justify-between sm:block">
                    <dt className="text-lumo-fg-low">Enrolled</dt>
                    <dd className="text-lumo-fg-high">
                      {clone.createdAt
                        ? new Date(clone.createdAt).toLocaleDateString()
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between sm:block">
                    <dt className="text-lumo-fg-low">Last used</dt>
                    <dd className="text-lumo-fg-high">
                      {clone.lastUsedAt
                        ? new Date(clone.lastUsedAt).toLocaleString()
                        : "Not used yet"}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </>
          )}
        </section>

        {/* Actions card */}
        <section
          aria-labelledby="voice-actions-title"
          className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-4"
        >
          <h2
            id="voice-actions-title"
            className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg"
          >
            Manage
          </h2>

          {!clone || clone.cloneStatus === "not_enrolled" ? (
            <div className="space-y-3">
              <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed">
                You haven&apos;t enrolled a voice yet. Enrollment takes
                about two minutes — three short sentences read into your
                mic. Recordings are deleted within 24 hours.
              </p>
              <Link
                href="/onboarding/voice?next=/settings/voice"
                className="inline-flex items-center h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors"
              >
                Enroll my voice
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              <ManageRow
                title="Re-record my voice"
                description="Updates your voice profile with a fresh recording. Goes through the consent flow again. The old clone is deleted on the same 7-day SLA."
                action={
                  <Link
                    href="/onboarding/voice?next=/settings/voice&reenroll=1"
                    className="h-9 px-3.5 rounded-md border border-lumo-hair text-[12.5px] text-lumo-fg-high hover:bg-lumo-elevated transition-colors inline-flex items-center"
                  >
                    Re-record
                  </Link>
                }
              />
              <ManageRow
                title="Delete my voice"
                description="One click. Lumo stops using your voice immediately and permanently removes it from our systems and our voice provider within 7 days."
                action={
                  <button
                    type="button"
                    onClick={() => setRevokeOpen(true)}
                    disabled={
                      clone.cloneStatus === "pending_deletion" || revoking
                    }
                    className="h-9 px-3.5 rounded-md border border-red-500/30 bg-red-500/5 text-[12.5px] text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {clone.cloneStatus === "pending_deletion"
                      ? "Deletion in progress"
                      : "Delete my voice"}
                  </button>
                }
              />
            </div>
          )}
        </section>

        {/* Audit log */}
        <AuditLogPreview
          entries={audit}
          loading={auditLoading}
          error={auditError}
        />

        <p className="text-[11.5px] text-lumo-fg-low text-center pt-2">
          Voice cloning is governed by{" "}
          <a
            href="/legal/privacy#biometric"
            className="underline decoration-lumo-fg-low underline-offset-2 hover:text-lumo-fg-mid"
          >
            ADR-012 / our biometric data policy
          </a>
          .
        </p>
      </div>

      <RevocationDialog
        open={revokeOpen}
        onConfirm={handleRevoke}
        onCancel={() => setRevokeOpen(false)}
        busy={revoking}
      />
    </main>
  );
}

function ManageRow(props: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-md border border-lumo-hair bg-lumo-bg/40 p-3.5">
      <div className="space-y-0.5">
        <div className="text-[13.5px] font-medium text-lumo-fg-high">
          {props.title}
        </div>
        <p className="text-[12.5px] text-lumo-fg-mid leading-relaxed max-w-xl">
          {props.description}
        </p>
      </div>
      <div className="sm:flex-shrink-0">{props.action}</div>
    </div>
  );
}
