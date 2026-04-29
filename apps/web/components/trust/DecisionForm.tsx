"use client";

import { useState } from "react";

interface DecisionFormProps {
  queueId: string;
}

const REASONS = [
  "scope_not_justified",
  "automated_check_failed",
  "identity_not_verified",
  "security_review_required",
  "insufficient_install_history",
];

export function DecisionForm({ queueId }: DecisionFormProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState(REASONS[0]);
  const [notes, setNotes] = useState("");

  async function submit(outcome: "approve" | "reject" | "needs_changes") {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/trust/review/${encodeURIComponent(queueId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome,
          reason_codes: outcome === "approve" ? [] : [reason],
          notes,
        }),
      });
      const body = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setMessage("Decision recorded.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Decision failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-lumo-hair bg-lumo-surface p-4">
      <div>
        <label className="text-[12px] text-lumo-fg-low" htmlFor="reason-code">
          Reason code
        </label>
        <select
          id="reason-code"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 h-9 w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 text-[13px] text-lumo-fg"
        >
          {REASONS.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-[12px] text-lumo-fg-low" htmlFor="decision-notes">
          Notes
        </label>
        <textarea
          id="decision-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          className="mt-1 w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13px] text-lumo-fg"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit("approve")}
          className="rounded-md bg-emerald-500 px-3 py-2 text-[12px] font-medium text-black disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit("needs_changes")}
          className="rounded-md bg-yellow-400 px-3 py-2 text-[12px] font-medium text-black disabled:opacity-50"
        >
          Needs Changes
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit("reject")}
          className="rounded-md bg-red-500 px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {message ? <div className="text-[12px] text-lumo-fg-mid">{message}</div> : null}
    </div>
  );
}
