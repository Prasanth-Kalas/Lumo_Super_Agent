"use client";

/**
 * /admin/review-queue — Lumo-team inbox for partner submissions.
 *
 * Shows every pending submission at the top, reviewed ones below.
 * Each row expands to show the parsed manifest JSON for inspection.
 * Reviewer can approve, reject, or revoke (for previously-approved
 * rows that need to be pulled) with an optional note that surfaces
 * back to the publisher on /publisher.
 *
 * Admin-gated both client- and server-side. Client-side gate here
 * is UX-only; the server routes enforce the real check.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Submission {
  id: string;
  publisher_email: string;
  manifest_url: string;
  parsed_manifest: Record<string, unknown> | null;
  status: "pending" | "approved" | "rejected" | "revoked";
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewer_note: string | null;
}

export default function AdminReviewQueuePage() {
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/review-queue", {
        cache: "no-store",
      });
      if (res.status === 403) {
        setErr(
          "You're signed in but not on the admin allowlist. Add your email to LUMO_ADMIN_EMAILS.",
        );
        setSubs([]);
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.error as string | undefined) ?? `HTTP ${res.status}`,
        );
      }
      const j = (await res.json()) as { submissions?: Submission[] };
      setSubs(j.submissions ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSubs([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(
    id: string,
    decision: "approved" | "rejected" | "revoked",
  ) {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch("/api/admin/review-queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submission_id: id,
          decision,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.error as string | undefined) ?? `HTTP ${res.status}`,
        );
      }
      setNote("");
      setExpanded(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex flex-col">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-lumo-fg hover:text-lumo-accent transition-colors"
          >
            <BrandMark size={22} />
            <span className="text-[14px] font-semibold tracking-tight">
              Lumo
            </span>
            <span className="hidden sm:inline text-[12px] text-lumo-fg-low">
              /
            </span>
            <span className="hidden sm:inline text-[13px]">Admin — review queue</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-5 py-10 flex-1">
        {err ? (
          <div className="mb-5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
            {err}
          </div>
        ) : null}

        {!subs ? (
          <div className="text-[13px] text-lumo-fg-mid py-10">Loading…</div>
        ) : subs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-surface/40 p-10 text-center text-[13px] text-lumo-fg-mid">
            Queue is empty.
          </div>
        ) : (
          <ul className="space-y-2">
            {subs.map((s) => (
              <li
                key={s.id}
                className="rounded-xl border border-lumo-hair bg-lumo-surface"
              >
                <button
                  type="button"
                  onClick={() =>
                    setExpanded(expanded === s.id ? null : s.id)
                  }
                  className="w-full text-left px-4 py-3"
                  aria-expanded={expanded === s.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] text-lumo-fg">
                        {displayNameOf(s)}
                      </div>
                      <div className="text-[11.5px] text-lumo-fg-low num mt-0.5 truncate">
                        {s.publisher_email} · {s.manifest_url}
                      </div>
                    </div>
                    <StatusPill status={s.status} />
                  </div>
                </button>

                {expanded === s.id ? (
                  <div className="border-t border-lumo-hair px-4 py-3 space-y-3">
                    <pre className="text-[11.5px] text-lumo-fg-mid bg-lumo-bg border border-lumo-hair rounded-md p-3 overflow-x-auto max-h-64">
                      {JSON.stringify(s.parsed_manifest, null, 2)}
                    </pre>

                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Reviewer note (optional — surfaces to the publisher)"
                      className="w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13px] placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
                    />

                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => void decide(s.id, "approved")}
                        disabled={busyId === s.id}
                        className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:opacity-50"
                      >
                        {busyId === s.id ? "…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void decide(s.id, "rejected")}
                        disabled={busyId === s.id}
                        className="h-8 px-3 rounded-md border border-red-500/30 text-red-400 text-[12.5px] hover:bg-red-500/10 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      {s.status === "approved" ? (
                        <button
                          type="button"
                          onClick={() => void decide(s.id, "revoked")}
                          disabled={busyId === s.id}
                          className="h-8 px-3 rounded-md border border-lumo-hair text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated text-[12.5px] disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      ) : null}
                      {s.reviewer_note ? (
                        <span className="text-[11.5px] text-lumo-fg-low ml-auto">
                          last note: {s.reviewer_note}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function displayNameOf(s: Submission): string {
  const m = s.parsed_manifest as
    | { display_name?: string; agent_id?: string }
    | null;
  return m?.display_name ?? m?.agent_id ?? s.manifest_url;
}

function StatusPill({ status }: { status: Submission["status"] }) {
  const label =
    status === "pending"
      ? "pending"
      : status === "approved"
        ? "approved"
        : status === "rejected"
          ? "rejected"
          : "revoked";
  const tone =
    status === "approved"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : status === "pending"
        ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
        : "bg-lumo-elevated text-lumo-fg-low border-lumo-hair";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] border " +
        tone
      }
    >
      {label}
    </span>
  );
}
