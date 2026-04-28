"use client";

/**
 * RevocationDialog — the one-click "delete my voice" confirmation.
 *
 * ADR-012 §2.6 makes revocation a single click with a 7-day SLA. The
 * UX risk is that "single click" gets interpreted as "no confirmation"
 * — which leaves users one mis-click from nuking their clone. This
 * dialog is the confirmation, but it is *not* a friction-engine. It
 * shows the user exactly what will happen, in plain English, and
 * proceeds on a single button press.
 *
 * What the user sees:
 *   - The cloned-voice TTS path is disabled IMMEDIATELY (synchronous
 *     in-memory cache invalidation, per ADR §6 step 1). We tell them.
 *   - Provider/local deletion completes within 7 days. We tell them.
 *   - The audit row is written immediately. We tell them.
 *   - There is an optional "reason for deleting" textbox (free text,
 *     stored in the consent_revoked evidence_payload).
 *
 * Codex VOICE-1 wires the actual /api call. This component just owns
 * the surface + the optimistic UI state.
 */

import { useEffect, useRef, useState } from "react";

export interface RevocationDialogProps {
  open: boolean;
  /** Called when the user confirms deletion. Parent issues the
   *  revoke_voice_clone call and writes consent_revoked. */
  onConfirm: (payload: { reason: string | null }) => Promise<void> | void;
  onCancel: () => void;
  /** When true, a request is in flight; the confirm button locks. */
  busy?: boolean;
}

export function RevocationDialog(props: RevocationDialogProps) {
  const { open, onConfirm, onCancel, busy = false } = props;
  const [reason, setReason] = useState("");
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // Close on Esc and focus the cancel button on open. The cancel
  // button is the safe-default focus — accidental Enter doesn't
  // delete the user's voice.
  useEffect(() => {
    if (!open) return;
    cancelBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  function handleConfirm() {
    void onConfirm({ reason: reason.trim() ? reason.trim() : null });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revocation-title"
      aria-describedby="revocation-desc"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div
        className="absolute inset-0 bg-lumo-bg/80 backdrop-blur-sm"
        onClick={busy ? undefined : onCancel}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 shadow-xl space-y-4">
        <div className="space-y-2">
          <h2
            id="revocation-title"
            className="text-[18px] font-semibold tracking-[-0.02em] text-lumo-fg"
          >
            Delete your voice clone?
          </h2>
          <p
            id="revocation-desc"
            className="text-[13.5px] leading-relaxed text-lumo-fg-mid"
          >
            Your voice will be permanently deleted within 7 days. Lumo
            will stop using it immediately, and remove it from our
            systems and our voice provider before the SLA expires.
          </p>
        </div>

        <ul className="space-y-1.5 text-[12.5px] text-lumo-fg-high">
          <Bullet>
            <span className="text-lumo-fg-mid">Now —</span> the cloned-voice
            playback path is disabled. Lumo will use your stock voice.
          </Bullet>
          <Bullet>
            <span className="text-lumo-fg-mid">Within minutes —</span> we
            write a <code className="font-mono text-[11.5px]">consent_revoked</code>
            {" "}entry to your audit log.
          </Bullet>
          <Bullet>
            <span className="text-lumo-fg-mid">Within 7 days —</span> the
            voice profile is hard-deleted from Lumo and the upstream voice
            engine. You&apos;ll see a <code className="font-mono text-[11.5px]">voice_clone_deleted</code>
            {" "}entry when it lands.
          </Bullet>
        </ul>

        <div className="space-y-1.5">
          <label
            htmlFor="revocation-reason"
            className="block text-[12px] font-medium text-lumo-fg-high"
          >
            Optional — why are you deleting it?
          </label>
          <textarea
            id="revocation-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Helps us improve. Stored only in your audit log."
            rows={2}
            disabled={busy}
            className="w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-accent focus:outline-none focus:ring-2 focus:ring-lumo-accent/30 disabled:opacity-40"
            maxLength={500}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-9 px-3.5 rounded-md text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors disabled:opacity-50"
          >
            Keep my voice
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className="h-9 px-4 rounded-md bg-red-500 text-white text-[13px] font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete my voice"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 leading-relaxed">
      <span
        aria-hidden="true"
        className="mt-1.5 inline-block h-1 w-1 rounded-full bg-lumo-fg-low flex-shrink-0"
      />
      <span>{children}</span>
    </li>
  );
}

export default RevocationDialog;
