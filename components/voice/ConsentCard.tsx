"use client";

/**
 * ConsentCard — the disclosure + acknowledgment surface used in BOTH
 * voice-cloning onboarding and the settings re-consent flow (after a
 * consent_version bump). Visual + audit behavior are identical in
 * both surfaces; the parent decides what happens after the user
 * clicks "I authorize Lumo to clone my voice."
 *
 * Why it exists:
 *   - ADR-012 §5.1 requires a deliberate disclosure screen with seven
 *     specific points. Burying those points in different copy on
 *     different surfaces is how we end up with consent_version drift
 *     and an audit trail we can't defend. One component, one source
 *     of truth.
 *   - The 8 sealed invariants (ADR-012 §2.1–§2.8) get rendered as a
 *     plain-English checklist the user must visibly tick through.
 *     The "I understand" semantics live in §5.1; the "I authorize"
 *     semantics live in §5.3 (after recording). This card handles
 *     the FIRST gate — "you may proceed to record".
 *   - DPIA gating: if the parent passes `awaitingLegalReview=true`
 *     we render the disclosure read-only and replace the action with
 *     a notice. Cloning is sealed-off until external counsel signs
 *     off (Kalas owns this review).
 *
 * Audit hooks (parent-supplied):
 *   - onAcknowledge(consentTextHash) — fires when the user completes
 *     all checkboxes + clicks the primary action. Parent computes
 *     the SHA-256 of the rendered disclosure text + invariant copy
 *     and writes the consent_granted row.
 *   - The component DOES NOT call any /api endpoints itself. Codex
 *     wires the audit write in VOICE-1.
 *
 * Accessibility:
 *   - Every checkbox is a real <input type="checkbox">, never
 *     pre-checked, with an id/htmlFor binding so screen readers
 *     announce the label.
 *   - Primary action is disabled until every checkbox is ticked AND
 *     the user has typed the acknowledgment phrase. The disabled
 *     state has aria-disabled='true' and a tooltip explaining why.
 *   - Tab order flows top-to-bottom; Esc cancels via onCancel.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface ConsentCardProps {
  /** Disclosure version string, baked into the text hash. */
  consentVersion: string;
  /** When true, render the card but block the primary action with a
   *  notice that legal review is pending. The user can read the full
   *  disclosure but cannot proceed. */
  awaitingLegalReview?: boolean;
  /** Called when the user has acknowledged everything and pressed
   *  the primary action. The parent is responsible for hashing and
   *  writing the consent_granted audit row.
   *
   *  @param payload.acknowledgmentText — the literal phrase the user
   *  typed; the parent may want to log a hash of it.
   */
  onAcknowledge: (payload: { acknowledgmentText: string }) => void;
  /** Called when the user backs out before authorizing. */
  onCancel: () => void;
  /** Override the primary action label. Defaults to "I authorize Lumo
   *  to clone my voice — start recording". Settings re-consent uses
   *  "Re-authorize". */
  primaryActionLabel?: string;
}

const REQUIRED_ACKNOWLEDGMENT = "I authorize Lumo to clone my voice";

/**
 * The 8 invariants from ADR-012 §2, rendered in plain English. The
 * user ticks each box. The wording here is the audit-defensible
 * version — do not edit without bumping consentVersion.
 */
const INVARIANTS: { id: string; label: string }[] = [
  {
    id: "no_default_on",
    label:
      "Voice cloning is off until I turn it on here. Lumo will not enable it for me, my workspace, or anyone on my team.",
  },
  {
    id: "no_incidental",
    label:
      "Only the audio I record on this screen will be used. Lumo will never use background audio, dictation, or wake-word recordings to clone my voice.",
  },
  {
    id: "audit_trail",
    label:
      "Every time my cloned voice is used, Lumo writes an entry to my audit log. I can review this log in settings.",
  },
  {
    id: "sample_retention",
    label:
      "My raw recording is deleted from Lumo's servers within 24 hours of the clone being created. Only the encrypted voice profile is kept after that.",
  },
  {
    id: "owner_only",
    label:
      "Only I can use my voice. Agents acting on my behalf, other workspace members, and Lumo staff cannot use my voice clone.",
  },
  {
    id: "revocation_sla",
    label:
      "I can delete my voice with one click. Lumo will permanently remove it from its systems and its voice provider within 7 days.",
  },
  {
    id: "use_disclosure",
    label:
      "Whenever Lumo plays back something in my voice, that fact is logged and surfaces visibly to me on supported screens.",
  },
  {
    id: "encryption_at_rest",
    label:
      "My voice profile is encrypted at rest. The decryption key is never exposed to my browser or to any agent.",
  },
];

export function ConsentCard(props: ConsentCardProps) {
  const {
    consentVersion,
    awaitingLegalReview = false,
    onAcknowledge,
    onCancel,
    primaryActionLabel = "I authorize Lumo to clone my voice — start recording",
  } = props;

  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [acknowledgment, setAcknowledgment] = useState("");
  const firstCheckboxRef = useRef<HTMLInputElement>(null);

  // Focus the first checkbox on mount so a keyboard user lands inside
  // the consent surface, not on the page header.
  useEffect(() => {
    firstCheckboxRef.current?.focus();
  }, []);

  // Esc cancels — matches modal conventions in the rest of the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const allChecked = useMemo(
    () => INVARIANTS.every((inv) => checked[inv.id] === true),
    [checked],
  );
  const phraseMatches =
    acknowledgment.trim().toLowerCase() ===
    REQUIRED_ACKNOWLEDGMENT.toLowerCase();
  const canProceed = allChecked && phraseMatches && !awaitingLegalReview;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canProceed) return;
    onAcknowledge({ acknowledgmentText: acknowledgment.trim() });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-6"
      aria-labelledby="consent-card-title"
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2
            id="consent-card-title"
            className="text-[18px] sm:text-[20px] font-semibold tracking-[-0.02em] text-lumo-fg"
          >
            Voice cloning consent
          </h2>
          <span className="text-[11px] text-lumo-fg-low font-mono">
            v{consentVersion}
          </span>
        </div>
        <p className="text-[13.5px] leading-relaxed text-lumo-fg-mid">
          Voice prints are biometric data. Lumo treats them with the same
          care as a password. Read the points below before you continue —
          each one is a binding promise about how Lumo handles your voice.
        </p>
      </div>

      {awaitingLegalReview ? (
        <div
          role="status"
          className="rounded-md border border-lumo-warn/30 bg-lumo-warn/10 px-3 py-2.5 text-[12.5px] text-lumo-warn"
        >
          Voice cloning is paused while external legal review completes.
          You can read the disclosure, but enrollment will be available
          after counsel signs off. We&apos;ll notify you here.
        </div>
      ) : null}

      <fieldset className="space-y-3" aria-describedby="invariants-help">
        <legend className="text-[12.5px] font-medium text-lumo-fg-high">
          Confirm you understand each of these
        </legend>
        <p id="invariants-help" className="text-[12px] text-lumo-fg-low">
          Each box must be ticked individually. None are pre-checked.
        </p>
        <ul className="space-y-2">
          {INVARIANTS.map((inv, idx) => {
            const id = `consent-${inv.id}`;
            return (
              <li key={inv.id}>
                <label
                  htmlFor={id}
                  className="flex items-start gap-3 rounded-md border border-lumo-hair bg-lumo-bg/50 p-3 cursor-pointer hover:border-lumo-fg-low/40 transition-colors"
                >
                  <input
                    ref={idx === 0 ? firstCheckboxRef : undefined}
                    id={id}
                    name={id}
                    type="checkbox"
                    checked={checked[inv.id] === true}
                    onChange={(e) =>
                      setChecked((c) => ({ ...c, [inv.id]: e.target.checked }))
                    }
                    disabled={awaitingLegalReview}
                    className="mt-0.5 h-4 w-4 rounded border-lumo-hair bg-lumo-bg text-lumo-accent focus:ring-2 focus:ring-lumo-accent focus:ring-offset-0 disabled:opacity-40"
                    aria-describedby={`${id}-text`}
                  />
                  <span
                    id={`${id}-text`}
                    className="text-[13px] leading-relaxed text-lumo-fg-high"
                  >
                    {inv.label}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="space-y-2">
        <label
          htmlFor="consent-acknowledgment"
          className="block text-[12.5px] font-medium text-lumo-fg-high"
        >
          Type the phrase below to authorize
        </label>
        <p className="text-[12px] text-lumo-fg-low">
          Type exactly:{" "}
          <span className="font-mono text-lumo-fg">
            {REQUIRED_ACKNOWLEDGMENT}
          </span>
        </p>
        <input
          id="consent-acknowledgment"
          name="consent-acknowledgment"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={acknowledgment}
          onChange={(e) => setAcknowledgment(e.target.value)}
          disabled={awaitingLegalReview}
          aria-invalid={
            acknowledgment.length > 0 && !phraseMatches ? "true" : "false"
          }
          className="w-full h-10 rounded-md border border-lumo-hair bg-lumo-bg px-3 text-[13.5px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-accent focus:outline-none focus:ring-2 focus:ring-lumo-accent/30 disabled:opacity-40"
          placeholder={REQUIRED_ACKNOWLEDGMENT}
        />
      </div>

      <div className="rounded-md border border-lumo-hair bg-lumo-bg/40 p-3 text-[12px] text-lumo-fg-mid">
        <a
          href="/legal/privacy#biometric"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-lumo-fg-low underline-offset-2 hover:text-lumo-fg hover:decoration-lumo-accent"
        >
          Read the biometric data section of our privacy policy →
        </a>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 px-3.5 rounded-md text-[12.5px] text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canProceed}
          aria-disabled={!canProceed}
          title={
            awaitingLegalReview
              ? "Awaiting external legal review"
              : !allChecked
                ? "Tick each acknowledgment to continue"
                : !phraseMatches
                  ? "Type the authorization phrase exactly to continue"
                  : ""
          }
          className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[13px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {primaryActionLabel}
        </button>
      </div>
    </form>
  );
}

export default ConsentCard;
